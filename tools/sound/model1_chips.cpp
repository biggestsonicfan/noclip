/*
 * model1_chips.cpp — the Model 1 sound board's two kinds of sound chip.
 *
 * MultiPCM (Yamaha YMW-258-F, Sega 315-5560): MAME's gew.cpp and
 * multipcm.cpp (BSD-3-Clause, Miguel Angel Horna), carried over line for line
 * with the device plumbing taken off, so a voice sounds as it does in MAME.
 * The one change is where the samples are read from: MAME's address map for
 * the board (segam1audio.cpp) puts the ROM's first megabyte at 0 and a bank
 * of it, picked by the 68000, at 0x100000; the rest of the chip's 4 MB space
 * reads 0.
 *
 * YM3438: ymfm (BSD-3-Clause, Aaron Giles), MAME's own core for it, with its
 * two timers and busy flag kept in the chip's own clocks here instead of
 * MAME's scheduler — the sound driver keeps its tempo by polling the timers.
 *
 * model1.c calls these through the C functions at the end.
 */
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <algorithm>

#include "ymfm_opn.h"

namespace {

/* ---- MultiPCM ---------------------------------------------------------------- */

const int32_t VALUE_TO_CHANNEL[32] = {
    0, 1, 2, 3, 4, 5, 6, -1,
    7, 8, 9, 10, 11, 12, 13, -1,
    14, 15, 16, 17, 18, 19, 20, -1,
    21, 22, 23, 24, 25, 26, 27, -1,
};

const double BASE_TIMES[64] = {
    0,          0,          0,          0,
    6222.95,    4978.37,    4148.66,    3556.01,
    3111.47,    2489.21,    2074.33,    1778.00,
    1555.74,    1244.63,    1037.19,    889.02,
    777.87,     622.31,     518.59,     444.54,
    388.93,     311.16,     259.32,     222.27,
    194.47,     155.60,     129.66,     111.16,
    97.23,      77.82,      64.85,      55.60,
    48.62,      38.91,      32.43,      27.80,
    24.31,      19.46,      16.24,      13.92,
    12.15,      9.75,       8.12,       6.98,
    6.08,       4.90,       4.08,       3.49,
    3.04,       2.49,       2.13,       1.90,
    1.72,       1.41,       1.18,       1.04,
    0.91,       0.73,       0.59,       0.50,
    0.45,       0.45,       0.45,       0.45,
};

const float LFO_FREQ[8] = { 0.168f, 2.019f, 3.196f, 4.206f, 5.215f, 5.888f, 6.224f, 7.066f };
const float PHASE_SCALE_LIMIT[8] = { 0.0f, 3.378f, 5.065f, 6.750f, 10.114f, 20.170f, 40.180f, 79.307f };
const float AMPLITUDE_SCALE_LIMIT[8] = { 0.0f, 0.4f, 0.8f, 1.5f, 3.0f, 6.0f, 12.0f, 24.0f };

constexpr uint32_t TL_SHIFT = 12;
constexpr uint32_t EG_SHIFT = 16;
constexpr uint32_t LFO_SHIFT = 8;
constexpr int VOICES = 28;

enum class state_t : uint8_t { ATTACK, DECAY1, DECAY2, RELEASE };

struct sample_t {
    uint32_t m_start = 0, m_loop = 0, m_end = 0;
    uint8_t m_attack_reg = 0, m_decay1_reg = 0, m_decay2_reg = 0, m_decay_level = 0;
    uint8_t m_release_reg = 0, m_key_rate_scale = 0, m_lfo_vibrato_reg = 0, m_lfo_amplitude_reg = 0;
    uint8_t m_format = 0;
};

struct envelope_gen_t {
    int32_t m_volume = 0;
    state_t m_state = state_t::ATTACK;
    uint8_t m_reverb = 0;
    int32_t m_attack_rate = 0, m_decay1_rate = 0, m_decay2_rate = 0, m_release_rate = 0, m_decay_level = 0;
};

struct lfo_t {
    uint16_t m_phase = 0;
    uint32_t m_phase_step = 0;
    int32_t *m_table = nullptr;
    int32_t *m_scale = nullptr;
};

struct slot_t {
    uint8_t m_regs[11] = {};
    bool m_playing = false;
    sample_t m_sample;
    uint32_t m_offset = 0;
    uint8_t m_octave = 0;
    uint16_t m_pitch = 0;
    uint32_t m_step = 0;
    bool m_reverse = false;
    uint32_t m_pan = 0;
    uint8_t m_dsp_send = 0;
    uint32_t m_total_level = 0, m_dest_total_level = 0;
    int32_t m_total_level_step = 0;
    int32_t m_prev_sample = 0;
    envelope_gen_t m_envelope_gen;
    uint8_t m_lfo_frequency = 0;
    lfo_t m_pitch_lfo;
    uint8_t m_vibrato = 0;
    lfo_t m_amplitude_lfo;
    uint8_t m_tremolo = 0;
};

uint32_t value_to_fixed(uint32_t bits, float value) {
    return uint32_t(float(1 << bits) * value);
}

/* The tables every chip shares; they depend only on the output rate. */
struct tables_t {
    float rate;
    uint32_t attack_step[0x40], decay_release_step[0x40], freq_step[0x400];
    int32_t left_pan[0x800], right_pan[0x800], lin_to_exp[0x400], tl_steps[2];
    int32_t pitch_table[256], amplitude_table[256];
    int32_t pitch_scale[8][256], amplitude_scale[8][256];

    void init(float r) {
        rate = r;
        for (int32_t level = 0; level < 0x80; ++level) {
            const float vol_db = (float)level * (-24.0f) / 64.0f;
            const float total_level = powf(10.0f, vol_db / 20.0f) / 4.0f;
            for (int32_t pan = 0; pan < 0x10; ++pan) {
                float pan_left, pan_right;
                if (pan == 0x8) {
                    pan_left = 0.0; pan_right = 0.0;
                } else if (pan == 0x0) {
                    pan_left = 1.0; pan_right = 1.0;
                } else if (pan & 0x8) {
                    pan_left = 1.0;
                    const int32_t inverted_pan = 0x10 - pan;
                    const float pan_vol_db = (float)inverted_pan * (-12.0f) / 4.0f;
                    pan_right = pow(10.0f, pan_vol_db / 20.0f);
                    if ((inverted_pan & 0x7) == 7) pan_right = 0.0;
                } else {
                    pan_right = 1.0;
                    const float pan_vol_db = (float)pan * (-12.0f) / 4.0f;
                    pan_left = pow(10.0f, pan_vol_db / 20.0f);
                    if ((pan & 0x7) == 7) pan_left = 0.0;
                }
                left_pan[(pan << 7) | level] = value_to_fixed(TL_SHIFT, pan_left * total_level);
                right_pan[(pan << 7) | level] = value_to_fixed(TL_SHIFT, pan_right * total_level);
            }
        }
        for (int32_t i = 0; i < 0x400; ++i) {
            const float fcent = rate * (1024.0f + (float)i) / 1024.0f;
            freq_step[i] = value_to_fixed(TL_SHIFT, fcent);
        }
        const double attack_decay_ratio = 14.32833;
        for (int32_t i = 4; i < 0x40; ++i) {
            attack_step[i] = (float)(0x400 << EG_SHIFT) / (float)(BASE_TIMES[i] * 44100.0 / 1000.0);
            decay_release_step[i] = (float)(0x400 << EG_SHIFT) / (float)(BASE_TIMES[i] * attack_decay_ratio * 44100.0 / 1000.0);
        }
        attack_step[0] = attack_step[1] = attack_step[2] = attack_step[3] = 0;
        attack_step[0x3f] = 0x400 << EG_SHIFT;
        decay_release_step[0] = decay_release_step[1] = decay_release_step[2] = decay_release_step[3] = 0;
        tl_steps[0] = -(float)(0x80 << TL_SHIFT) / (78.2f * 44100.0f / 1000.0f);
        tl_steps[1] = (float)(0x80 << TL_SHIFT) / (78.2f * 2 * 44100.0f / 1000.0f);
        for (int32_t i = 0; i < 0x400; ++i) {
            const float db = -(96.0f - (96.0f * (float)i / (float)0x400));
            lin_to_exp[i] = value_to_fixed(TL_SHIFT, powf(10.0f, db / 20.0f));
        }
        for (int32_t i = 0; i < 256; ++i) {
            if (i < 64) pitch_table[i] = i * 2 + 128;
            else if (i < 128) pitch_table[i] = 383 - i * 2;
            else if (i < 192) pitch_table[i] = 384 - i * 2;
            else pitch_table[i] = i * 2 - 383;
            amplitude_table[i] = i < 128 ? 255 - (i * 2) : (i * 2) - 256;
        }
        for (int32_t table = 0; table < 8; ++table) {
            float limit = PHASE_SCALE_LIMIT[table];
            for (int32_t i = -128; i < 128; ++i) {
                const float value = (limit * (float)i) / 128.0f;
                pitch_scale[table][i + 128] = value_to_fixed(LFO_SHIFT, powf(2.0f, value / 1200.0f));
            }
            limit = -AMPLITUDE_SCALE_LIMIT[table];
            for (int32_t i = 0; i < 256; ++i) {
                const float value = (limit * (float)i) / 256.0f;
                amplitude_scale[table][i] = value_to_fixed(LFO_SHIFT, powf(10.0f, value / 20.0f));
            }
        }
    }
};

tables_t T;

struct multipcm_t {
    slot_t slots[VOICES];
    int32_t cur_slot = 0;
    int32_t address = 0;
    const uint8_t *rom = nullptr;   /* 4 MB */
    uint32_t bank = 0;

    uint8_t read_byte(uint32_t a) const {
        a &= 0x3fffff;
        if (a < 0x100000) return rom[a];
        if (a < 0x200000) return rom[(bank << 20) | (a & 0xfffff)];
        return 0;
    }

    void init_sample(sample_t &sample, uint32_t index) {
        uint32_t address = index * 12;
        sample.m_start = (read_byte(address) << 16) | (read_byte(address + 1) << 8) | read_byte(address + 2);
        sample.m_format = (sample.m_start >> 20) & 0xfe;
        sample.m_start &= 0x3fffff;
        sample.m_loop = (read_byte(address + 3) << 8) | read_byte(address + 4);
        sample.m_end = 0x10000 - ((read_byte(address + 5) << 8) | read_byte(address + 6));
        sample.m_attack_reg = (read_byte(address + 8) >> 4) & 0xf;
        sample.m_decay1_reg = read_byte(address + 8) & 0xf;
        sample.m_decay2_reg = read_byte(address + 9) & 0xf;
        sample.m_decay_level = (read_byte(address + 9) >> 4) & 0xf;
        sample.m_release_reg = read_byte(address + 10) & 0xf;
        sample.m_key_rate_scale = (read_byte(address + 10) >> 4) & 0xf;
        sample.m_lfo_vibrato_reg = read_byte(address + 7);
        sample.m_lfo_amplitude_reg = read_byte(address + 11) & 0xf;
    }

    static uint32_t get_rate(const uint32_t *steps, int32_t rate, uint32_t val) {
        if (val == 0) return steps[0];
        if (val == 0xf) return steps[0x3f];
        const int r = std::clamp(4 * (int)val + rate, 0, 0x3f);
        return steps[r];
    }

    static void envelope_generator_calc(slot_t &slot) {
        int32_t octave = slot.m_octave;
        if (octave & 8) octave = octave - 16;
        int32_t rate;
        if (slot.m_sample.m_key_rate_scale != 0xf)
            rate = (octave + slot.m_sample.m_key_rate_scale) * 2 + ((slot.m_pitch >> 9) & 1);
        else
            rate = 0;
        slot.m_envelope_gen.m_attack_rate = get_rate(T.attack_step, rate, slot.m_sample.m_attack_reg);
        slot.m_envelope_gen.m_decay1_rate = get_rate(T.decay_release_step, rate, slot.m_sample.m_decay1_reg);
        slot.m_envelope_gen.m_decay2_rate = get_rate(T.decay_release_step, rate, slot.m_sample.m_decay2_reg);
        slot.m_envelope_gen.m_release_rate = get_rate(T.decay_release_step, rate, slot.m_sample.m_release_reg);
        slot.m_envelope_gen.m_decay_level = 0xf - slot.m_sample.m_decay_level;
        slot.m_envelope_gen.m_reverb = false;
    }

    static int32_t envelope_generator_update(slot_t &slot) {
        envelope_gen_t &eg = slot.m_envelope_gen;
        switch (eg.m_state) {
        case state_t::ATTACK:
            eg.m_volume += (int64_t((0x817 << (EG_SHIFT - 1)) - eg.m_volume) * eg.m_attack_rate) >> 24;
            if (eg.m_volume >= (0x3ff << EG_SHIFT)) {
                eg.m_state = state_t::DECAY1;
                if (eg.m_decay1_rate >= (0x400 << EG_SHIFT)) eg.m_state = state_t::DECAY2;
                eg.m_volume = 0x3ff << EG_SHIFT;
            }
            break;
        case state_t::DECAY1:
            eg.m_volume -= eg.m_decay1_rate;
            if (eg.m_volume <= 0) eg.m_volume = 0;
            if (eg.m_volume >> (EG_SHIFT + 6) <= eg.m_decay_level) eg.m_state = state_t::DECAY2;
            break;
        case state_t::DECAY2:
            eg.m_volume -= eg.m_decay2_rate;
            if (eg.m_volume <= 0) eg.m_volume = 0;
            break;
        case state_t::RELEASE:
            eg.m_volume -= eg.m_release_rate;
            if (eg.m_volume <= 0) {
                eg.m_volume = 0;
                slot.m_playing = false;
            }
            break;
        default:
            return 1 << TL_SHIFT;
        }
        /* MAME's GEW7-only reverb rule: m_reverb is never set on a MultiPCM. */
        return T.lin_to_exp[eg.m_volume >> EG_SHIFT];
    }

    static void retrigger_sample(slot_t &slot) {
        slot.m_offset = 0;
        slot.m_prev_sample = 0;
        slot.m_total_level = slot.m_dest_total_level << TL_SHIFT;
        envelope_generator_calc(slot);
        slot.m_envelope_gen.m_state = state_t::ATTACK;
        slot.m_envelope_gen.m_volume = (0x3ff - 0x2a0) << EG_SHIFT;
    }

    static void update_step(slot_t &slot) {
        const uint8_t oct = (slot.m_octave - 1) & 0xf;
        uint32_t pitch = T.freq_step[slot.m_pitch];
        if (oct & 0x8) pitch >>= (16 - oct);
        else pitch <<= oct;
        slot.m_step = pitch / T.rate;
    }

    static void lfo_compute_step(lfo_t &lfo, uint32_t lfo_frequency, uint32_t lfo_scale, int32_t amplitude_lfo) {
        float step = (float)LFO_FREQ[lfo_frequency] * 256.0f / (float)T.rate;
        lfo.m_phase_step = uint32_t(float(1 << LFO_SHIFT) * step);
        if (amplitude_lfo) {
            lfo.m_table = T.amplitude_table;
            lfo.m_scale = T.amplitude_scale[lfo_scale];
        } else {
            lfo.m_table = T.pitch_table;
            lfo.m_scale = T.pitch_scale[lfo_scale];
        }
    }

    static int32_t lfo_step(lfo_t &lfo) {
        lfo.m_phase += lfo.m_phase_step;
        int32_t p = lfo.m_table[(lfo.m_phase >> LFO_SHIFT) & 0xff];
        p = lfo.m_scale[p];
        return p << (TL_SHIFT - LFO_SHIFT);
    }

    void write_slot(slot_t &slot, int32_t reg, uint8_t data) {
        slot.m_regs[reg] = data;
        switch (reg) {
        case 0:
            slot.m_pan = (data >> 4) & 0xf;
            slot.m_dsp_send = data & 0xf;
            break;
        case 1:
            init_sample(slot.m_sample, slot.m_regs[1] | ((slot.m_regs[2] & 1) << 8));
            slot.m_regs[7] = (slot.m_sample.m_attack_reg << 4) | slot.m_sample.m_decay1_reg;
            slot.m_regs[8] = (slot.m_sample.m_decay_level << 4) | slot.m_sample.m_decay2_reg;
            slot.m_regs[9] = (slot.m_sample.m_key_rate_scale << 4) | slot.m_sample.m_release_reg;
            write_slot(slot, 6, slot.m_sample.m_lfo_vibrato_reg);
            write_slot(slot, 10, slot.m_sample.m_lfo_amplitude_reg);
            if (slot.m_playing) retrigger_sample(slot);
            break;
        case 2:
        case 3:
            slot.m_octave = slot.m_regs[3] >> 4;
            slot.m_pitch = ((slot.m_regs[3] & 0xf) << 6) | (slot.m_regs[2] >> 2);
            update_step(slot);
            break;
        case 4:
            if (data & 0x80) {
                slot.m_playing = true;
                retrigger_sample(slot);
            } else if (slot.m_playing) {
                if (slot.m_sample.m_release_reg != 0xf) slot.m_envelope_gen.m_state = state_t::RELEASE;
                else slot.m_playing = false;
            }
            break;
        case 5:
            slot.m_dest_total_level = (data >> 1) & 0x7f;
            if (!(data & 1)) {
                if ((slot.m_total_level >> TL_SHIFT) > slot.m_dest_total_level) slot.m_total_level_step = T.tl_steps[0];
                else slot.m_total_level_step = T.tl_steps[1];
            } else {
                slot.m_total_level = slot.m_dest_total_level << TL_SHIFT;
            }
            break;
        case 6:
        case 10:
            slot.m_lfo_frequency = (slot.m_regs[6] >> 3) & 7;
            slot.m_vibrato = slot.m_regs[6] & 7;
            slot.m_tremolo = slot.m_regs[10] & 7;
            if (data) {
                lfo_compute_step(slot.m_pitch_lfo, slot.m_lfo_frequency, slot.m_vibrato, 0);
                lfo_compute_step(slot.m_amplitude_lfo, slot.m_lfo_frequency, slot.m_tremolo, 1);
            }
            break;
        case 7:
        case 8:
        case 9:
            slot.m_sample.m_attack_reg = slot.m_regs[7] >> 4;
            slot.m_sample.m_decay1_reg = slot.m_regs[7] & 0xf;
            slot.m_sample.m_decay_level = slot.m_regs[8] >> 4;
            slot.m_sample.m_decay2_reg = slot.m_regs[8] & 0xf;
            slot.m_sample.m_key_rate_scale = slot.m_regs[9] >> 4;
            slot.m_sample.m_release_reg = slot.m_regs[9] & 0xf;
            envelope_generator_calc(slot);
            break;
        }
    }

    void write(uint32_t offset, uint8_t data) {
        switch (offset) {
        case 0:
            if (address < 11 && cur_slot >= 0) write_slot(slots[cur_slot], address, data);
            break;
        case 1:
            cur_slot = VALUE_TO_CHANNEL[data & 0x1f];
            break;
        case 2:
            address = data;
            break;
        }
    }

    /* One output sample, as gew_pcm_device::sound_stream_update makes it,
     * before put_int_clamp's clamp to 16 bits. */
    void sample(int32_t &outl, int32_t &outr) {
        int32_t smpl = 0, smpr = 0;
        for (int32_t sl = 0; sl < VOICES; ++sl) {
            slot_t &slot = slots[sl];
            if (!slot.m_playing) continue;
            uint32_t vol = (slot.m_total_level >> TL_SHIFT) | (slot.m_pan << 7);
            uint32_t spos = slot.m_offset >> TL_SHIFT;
            uint32_t step = slot.m_step;
            int32_t csample = 0;
            int32_t fpart = slot.m_offset & ((1 << TL_SHIFT) - 1);
            if (slot.m_reverse) spos = slot.m_sample.m_end - spos - 1;
            if (slot.m_sample.m_format & 4) {
                uint32_t adr = slot.m_sample.m_start + (spos >> 1) * 3;
                if (!(spos & 1)) {
                    int16_t w0 = read_byte(adr) << 8 | ((read_byte(adr + 1) & 0xf) << 4);
                    csample = w0;
                } else {
                    int16_t w0 = (read_byte(adr + 2) << 8) | (read_byte(adr + 1) & 0xf0);
                    csample = w0;
                }
            } else {
                csample = (int16_t)(read_byte(slot.m_sample.m_start + spos) << 8);
            }
            int32_t sample = (csample * fpart + slot.m_prev_sample * ((1 << TL_SHIFT) - fpart)) >> TL_SHIFT;
            if (slot.m_vibrato) {
                step = step * lfo_step(slot.m_pitch_lfo);
                step >>= TL_SHIFT;
            }
            slot.m_offset += step;
            if (spos ^ (slot.m_offset >> TL_SHIFT)) slot.m_prev_sample = csample;
            if (slot.m_offset >= (slot.m_sample.m_end << TL_SHIFT)) {
                slot.m_offset -= (slot.m_sample.m_end - slot.m_sample.m_loop) << TL_SHIFT;
                slot.m_reverse = false;
            }
            if ((slot.m_total_level >> TL_SHIFT) != slot.m_dest_total_level)
                slot.m_total_level += slot.m_total_level_step;
            if (slot.m_tremolo) {
                sample = sample * lfo_step(slot.m_amplitude_lfo);
                sample >>= TL_SHIFT;
            }
            sample = (sample * envelope_generator_update(slot)) >> 10;
            smpl += (T.left_pan[vol] * sample) >> TL_SHIFT;
            smpr += (T.right_pan[vol] * sample) >> TL_SHIFT;
        }
        outl = std::clamp(smpl, -32768, 32767);
        outr = std::clamp(smpr, -32768, 32767);
    }
};

multipcm_t g_pcm[2];

/* ---- YM3438 ------------------------------------------------------------------ */

/* The chip's clock count, which model1.c advances; timers and the busy flag
 * are kept against it. */
struct ym_host : public ymfm::ymfm_interface {
    uint64_t now = 0;
    int64_t timer_at[2] = { -1, -1 };
    uint64_t busy_end = 0;

    void ymfm_set_timer(uint32_t tnum, int32_t clocks) override {
        timer_at[tnum] = clocks >= 0 ? int64_t(now + clocks) : -1;
    }
    void ymfm_set_busy_end(uint32_t clocks) override { busy_end = now + clocks; }
    bool ymfm_is_busy() override { return now < busy_end; }

    void advance(uint64_t to) {
        for (;;) {
            int t = -1;
            for (int i = 0; i < 2; i++)
                if (timer_at[i] >= 0 && uint64_t(timer_at[i]) <= to && (t < 0 || timer_at[i] < timer_at[t])) t = i;
            if (t < 0) break;
            now = uint64_t(timer_at[t]);
            timer_at[t] = -1;
            m_engine->engine_timer_expired(t);
        }
        now = to;
    }
};

ym_host g_ymhost;
ymfm::ym3438 *g_ym;

} // namespace

extern "C" {

void m1_chips_init(float pcm_rate, const uint8_t *pcm1, const uint8_t *pcm2) {
    T.init(pcm_rate);
    for (int i = 0; i < 2; i++) {
        g_pcm[i] = multipcm_t();
        g_pcm[i].rom = i ? pcm2 : pcm1;
    }
    static ymfm::ym3438 ym(g_ymhost);
    g_ym = &ym;
    g_ymhost.now = 0;
    g_ymhost.timer_at[0] = g_ymhost.timer_at[1] = -1;
    g_ymhost.busy_end = 0;
    g_ym->reset();
}

void m1_pcm_write(int chip, uint32_t offset, uint8_t data) { g_pcm[chip].write(offset, data); }
void m1_pcm_bank(int chip, uint32_t bank) { g_pcm[chip].bank = bank & 3; }
void m1_pcm_sample(int chip, int32_t *l, int32_t *r) { g_pcm[chip].sample(*l, *r); }

void m1_ym_advance(uint64_t clock) { g_ymhost.advance(clock); }
uint8_t m1_ym_read(uint32_t offset) { return g_ym->read(offset & 3); }
void m1_ym_write(uint32_t offset, uint8_t data) { g_ym->write(offset & 3, data); }
void m1_ym_sample(int32_t *l, int32_t *r) {
    ymfm::ym3438::output_data out;
    g_ym->generate(&out, 1);
    *l = out.data[0];
    *r = out.data[1];
}

}
