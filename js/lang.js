/*
 * lang.js — the page's languages (Pinboard #970).
 *
 *   noclip.sonicthefighte.rs/?lang=ja
 *
 * The same switch as m2-hle2's arcade site: ?lang=ja (or ?lang=jp) is
 * Japanese, and no ?lang=, or one the page has no words in, is English, the
 * default. The language is the page's words only; the ROM set decides what is
 * drawn, and the game's own names (stages, fighters, models, motions) are
 * shown as the ROM and the reading of it name them.
 *
 * English is written where it is used, so the page reads as it did; a language
 * is a table of what to put in its place, and anything the table leaves out
 * stays English. Two kinds of entry:
 *
 *   PAGE: index.html's own words, by key. The markup names them with
 *     data-i18n="key" (the element's HTML: a translation may carry <b>, <code>
 *     and the like), data-i18n-title, data-i18n-aria and
 *     data-i18n-placeholder. An element whose text sits beside an input wraps
 *     the text in a <span> and names that, so the input stays as it was.
 *   TEXT: what the scripts write, keyed by the English itself: t('Pause'), or
 *     t('{n} draws', { n }) with the {name}s filled in after the lookup.
 *
 * To add a language, add its two tables to LANGS; the switch in the corner
 * lists every entry.
 */

/* The visible words of index.html, by data-i18n key. */
const JA_PAGE = {
    'doc.title': 'セガ Model 2 — 3D エクスプローラー',
    'splash.title': 'セガ Model 2 <span>3D エクスプローラー</span>',
    'splash.sub': 'Model&nbsp;2 アーケードゲーム14本のアリーナ、コース、ファイター、モンスターの中を飛び回れます。'
        + 'すべてこのタブの中で、あなた自身の ROM セットから組み立てます。',
    'splash.showcase': 'エクスプローラーが描くもの',
    'reel.empty': 'このゲームのクリップはまだありません &mdash; <code id="reel-empty-zip"></code> をドロップして自分の目で確かめてください。',
    'reel.play': 'クリップを再生',

    'stf.meta': 'すべてのアリーナ、ファイター34人とそのモーション518個 &middot; <code>sfight</code> / <code>schamp</code>',
    'stf.clip.carpet': '<b>ライド</b>表示のフライングカーペット：アリーナは止まったまま、砂漠が周りを流れていく',
    'stf.clip.canyon': 'キャニオンクルーズ、峡谷を下るボートに乗って',
    'stf.clip.noclip': '<b>Noclip</b> でカジノナイトの壁を越え、リングへ降りていく',
    'stf.clip.giantwing': 'ジャイアントウイングの雲の中へ',
    'stf.clip.fighter': '専用リグで技の途中のソニック、残像つき',
    'stf.name': 'ソニック・ザ・ファイターズ',
    'hotd.name': 'ザ・ハウス・オブ・ザ・デッド',
    'hotd.meta': '18ステージと敵のボディ94体 &middot; <code>hotdo</code> / <code>hotd</code>',
    'hotd.clip.mansion': 'ステージ&nbsp;1 の3番目のセット、明かりのついた館の部屋の上',
    'hotd.clip.stage2': 'チャプター&nbsp;2 の6番目のセット、帯状の雲の下',
    'hotd.clip.body': '腕が刃になったゾンビ <code>BO_tetuman</code>、専用リグで',
    'hotdp.name': 'ザ・ハウス・オブ・ザ・デッド <i>プロトタイプ</i>',
    'hotdp.meta': '製品版の元になった Model 2C 版 &middot; <code>hotdp</code>',
    'hotdp.clip.room': 'ステージ&nbsp;1 の明かりのついた部屋に立って',
    'hotdp.clip.set3': 'ステージ&nbsp;1 の3番目のセットの上',
    'hotdp.clip.body': '関節に合わせて焼き込まれたモーションを再生するゾンビのボディ',
    'daytona.name': 'デイトナUSA',
    'daytona.meta': 'コース、車、コース脇のもの、8つのビルドで &middot; <code>daytona</code>',
    'daytona.clip.speedway': 'スリーセブン・スピードウェイ、スタートラインに並ぶグリッド',
    'daytona.clip.canyon': '岩の上から見たダイナソー・キャニオン',
    'daytona.clip.seaside': '水の上から見たシーサイド・ストリート・ギャラクシー',
    'vcop.name': 'バーチャコップ',
    'vcop.meta': '3つのステージ、リグに乗った敵、すべてのモデル &middot; <code>vcop</code>',
    'vcop.clip.warehouse': 'ステージ&nbsp;1 のレールに乗ってコンテナの間へ',
    'vcop.clip.site': 'ステージ&nbsp;2 のレール、赤い空の下の工事現場を横切って',
    'vcop.clip.tower': 'ステージ&nbsp;3 のレール、タワーのふもとを回って',
    'fvipers.name': 'ファイティングバイパーズ',
    'fvipers.meta': '16のアリーナ、ファイターとその技 &middot; <code>fvipers</code>',
    'fvipers.clip.arena': '最初のアリーナの壁に囲まれた中庭',
    'fvipers.clip.sunset': '同じ中庭の夕暮れ、別のアリーナのレコードが描いたもの',
    'fvipers.clip.ring': '街のスカイラインの下のロープつきリング',
    'vf2.name': 'バーチャファイター2',
    'vf2.meta': '音楽つきの12ステージと、リグに乗ったファイター &middot; <code>vf2</code>',
    'vf2.clip.islands': '海に突き出た緑の岬にあるアイランドのリング',
    'vf2.clip.wall': '万里、万里の長城の上のリング',
    'vf2.clip.snow': '山に切り込まれた雪山のリング',
    'vf2.clip.fighter': '専用リグのアキラ',
    'doa.name': 'デッド オア アライブ',
    'doa.meta': '12ステージとファイター、Model 2B と 2A で &middot; <code>doa</code> / <code>doab</code> / <code>doaa</code> / <code>doaab</code> / <code>doaae</code>',
    'von.name': '電脳戦機バーチャロン',
    'von.meta': '10ステージ（一部組み立て済み）と、リグに乗ったロボット &middot; <code>vonj</code> / <code>vonu</code>',
    'von.clip.airport': 'エアポートのフィールド、その壁の内側',
    'von.clip.deathtrap': '鉄骨の塔の中にあるデストラップのアリーナ',
    'von.clip.secretbase': 'シークレットベースの段々の輪',
    'srallyc.name': 'セガラリーチャンピオンシップ',
    'srallyc.meta': '4つのコース、車、観客 &middot; <code>srallyc</code>',
    'srallyc.clip.forest': '木々の間を縫うフォレストコース',
    'srallyc.clip.desert': '青空の下の砂漠のコース',
    'srallyc.clip.mountain': '雪の峰を背にしたマウンテンコース',
    'dynamcop.name': 'ダイナマイトコップ',
    'dynamcop.meta': '279のエリアとキャラクター、Model 2A、2B、2C で &middot; <code>dynamcop</code> / <code>dyndeka2</code>',
    'dynamcop.clip.ballroom': 'コース&nbsp;2-1 の舞踏室とそのテーブル',
    'dynamcop.clip.harbour': 'コース&nbsp;4-1 の洞窟の港に浮かぶガレオン船',
    'dynamcop.clip.deck': 'コース&nbsp;4-2、夜の甲板の上',
    'airwlkrs.name': 'エアウォーカーズ',
    'airwlkrs.meta': '17のコートと、リグに乗った選手 &middot; <code>airwlkrs</code>',
    'airwlkrs.clip.court': 'シアトル・ベロシティのホームコート、床すれすれに',
    'airwlkrs.clip.stands': 'スタンドの上から見たニューヨーク・スターズのコート',
    'airwlkrs.clip.player': '専用リグのシアトル・ベロシティの選手',
    'powsled.name': 'パワースレッド',
    'powsled.meta': 'コース、モデル、アトラクトのライドシーン &middot; <code>powsled</code>',
    'powsled.clip.start': 'スタートから岩の間を縫って下る滑走',
    'powsled.clip.tunnel': 'トンネルのシーン：氷の谷を下るコース',
    'powsled.clip.bridges': '橋のシーン、雪原の上へ',
    'powsled.clip.ride': 'アトラクトのライド：黄色いソリに乗る2人',
    'lastbrnx.name': 'ラストブロンクス',
    'lastbrnx.meta': '9つのステージ、その動く仕掛けと曲、リグに乗ったファイター &middot; <code>lastbrnx</code> / <code>lastbrnj</code>',
    'lastbrnx.clip.parking': '投光器に照らされたラディカル・パーキング・ロット',
    'lastbrnx.clip.garden': '高層ビルに囲まれたムーンライト・ガーデンのリング',
    'lastbrnx.clip.street': 'クロス・ストリートの屋上の上を',
    'lastbrnx.clip.fighter': '専用リグで勝利ポーズを決めるヨーコ',
    'pltkids.name': 'パイロットキッズ',
    'pltkids.meta': 'すべてのモデル、9つのシーンのテクスチャつき &middot; <code>pltkids</code> / <code>pltkidsa</code>',
    'pltkids.clip.pilot': '子どものパイロットの1人',
    'pltkids.clip.viking': '角の生えたボス',
    'pltkids.clip.dog': '犬',
    'doa.clip.palace': 'ステージ&nbsp;3 の壁に囲まれた宮殿の中庭',
    'doa.clip.sunset': 'ステージ&nbsp;11 の溶岩に囲まれた岩のリング',
    'doa.clip.city': 'ステージ&nbsp;10、夜の街の上',
    'doa.clip.fighter': '専用リグのかすみ',

    'load.title': 'あなたの ROM セットを使ってください',
    'load.sub': 'ビューアーは中のプログラム ROM からどのゲームのセットかを判断するので、zip の名前は何でもかまいません。',
    'load.ack': 'このプロジェクトの作成に支援 AI が使われたことを理解しています。',
    'drop.desktop': 'ここに ROM セットをドロップ',
    'drop.mobile': 'ROM セットを選ぶ',
    'drop.sub': 'どこにもアップロードされません。zip はこのタブの中で読み込まれます。',
    'drop.btn': 'ファイルを選ぶ&hellip;',
    'drop.lock': '上の確認にチェックを入れると有効になります',

    'romnote.summary': '各セットで見られるもの',
    'romnote.stf': '<b>ソニック・ザ・ファイターズ</b> &mdash; いちばん深く読めているゲームです。すべてのアリーナが'
        + '基板と同じ 60&nbsp;Hz で、そのレコードが求めるオブジェクトとともに動き、フライングカーペットと'
        + 'キャニオンクルーズのボートはコースを飛びます。モデルは全5103個。34人のキャラクター全員が'
        + '自分のリグでゲームの518個のモーションを再生し、揺れチェーン、テイルスのしっぽ、残像もつきます。'
        + 'このゲーム自身のプログラム EPROM <code>epr-19001</code>&ndash;<code>epr-19004</code> と、'
        + 'MAME が親セット <b>ソニック・チャンピオンシップ</b>（<code>schamp</code>）と共有するマスク ROM '
        + '<code>mpr-19005</code>&ndash;<code>mpr-19020</code> から組み立てます。<code>sfight.zip</code> だけ、'
        + '<code>schamp.zip</code> だけ、またはセットが2つに分かれていれば両方をドロップしてください。',
    'romnote.hotd': '<b>ザ・ハウス・オブ・ザ・デッド</b>（<code>hotdo.zip</code>）&mdash; 製品版です。'
        + '4つのチャプターを18のステージとして、開発時の名前のついた7477個のモデル、そして関節数に合わせて'
        + '焼き込まれた674個のモーションを再生する94体の敵のボディ。リビジョン A（<code>hotd.zip</code>）も'
        + '認識し、両方を含むマージ済みアーカイブも読めます &mdash; セットは zip の名前ではなく、'
        + '中のチップで見分けます。',
    'romnote.hotdp': '<b>ザ・ハウス・オブ・ザ・デッド（プロトタイプ）</b>（<code>hotdp.zip</code>）&mdash; '
        + '製品版の元になった Model 2C のプロトタイプを同じ方法で読みます。遊べる2つのステージ、'
        + '独自のモデル、そして507個のモーションを持つ68体のボディ。',
    'romnote.daytona': '<b>デイトナUSA</b>（<code>daytona.zip</code>）&mdash; ここで唯一、他のゲームが動く'
        + ' 2A/2B ではなく初代 Model 2 基板のゲームで、唯一8つのビルドで出荷されました。8つすべてを認識し、'
        + 'マージ済みアーカイブは一度に全部として読みます。パネルに<b>ビルド</b>の選択が現れ、切り替えは'
        + '一瞬です。中身が異なるのは2種類だけです &mdash; 1993年のデラックス版はテーブルが2822項目、それ以降の'
        + 'ビルドはすべて3190項目で、7つとも1バイト違わず同じテーブルです。カラーリングの入ったストックカーの'
        + 'グリッド、コースのトラック区間と沿道の風景が、コース自身のバンクのテクスチャで、ゲームが起動時に'
        + '計算するカラーテーブルを通して描かれます。コースも出てきます。それぞれ128単位のブロックの'
        + '16x16のグリッドで、ブロックごとに1つのモデルがその場所に描かれるので、ステージタブには'
        + 'スリーセブン・スピードウェイのオーバル、ダイナソー・キャニオン、シーサイド・ストリート・ギャラクシー、'
        + 'そして4番目のテーブルにある縞模様のテスト用の正方形が、タイルチップの空のパノラマの下に並びます。'
        + '沿道のものは基板と同じように動きます &mdash; スロットマシンのリール、サイコロ、風車、ボート、'
        + 'カモメ、近くを飛ぶと駆け出す馬 &mdash; そして選択肢でコースをレース、タイムアタック、'
        + 'エンディングとして描けます。<b>キャビネット</b>の切り替えで、テストメニューの設定と同じ'
        + 'カラーテーブルを選べます。車にはリグがなく動かないので、アニメーションタブはありません。',
    'romnote.fvipers': '<b>ファイティングバイパーズ</b>（<code>fvipers.zip</code>）&mdash; '
        + '16のアリーナと5413のテーブル項目が出てきます。'
        + 'このゲームとソニック・ザ・ファイターズが同じセガのライブラリで作られているので読めるのです。'
        + 'アリーナはそのレコードが指すオブジェクトを動かし、ファイターはバーチャファイター2のリグで1054のモーションを演じます。'
        + '技はそれを出す入力の下に並び、相手はゲームどおりのリアクションを返します。',
    'romnote.vcop': '<b>バーチャコップ</b>（<code>vcop.zip</code>、Revision B）&mdash; '
        + 'デイトナUSAと同じライブラリで、その1年後に作られたゲームです。基板が描くテーブルから読んだ3つのステージをレールカメラで進めます。'
        + 'モデル1234個、セル、敵のモーションも出てきます。',
    'romnote.vf2': '<b>バーチャファイター2</b>（<code>vf2.zip</code>、Version 2.1）&mdash; '
        + 'ゲームのデバッグメニューの名前がついた12ステージとその音楽とステージの音、'
        + 'モデルとセル、そしてリグに乗って技や連携を出すファイターが出てきます。',
    'romnote.doa': '<b>デッド オア アライブ</b>（<code>doa.zip</code>、ほかに <code>doab</code>、<code>doaa</code>、<code>doaab</code>、<code>doaae</code>）&mdash; '
        + '各ステージ自身のルーチンを i960 インタープリターで動かして組み立てた12ステージと、'
        + 'ゲーム自身の格闘コードがポーズをつけるファイターが、Model 2B 版でも 2A 版でも出てきます。',
    'romnote.von': '<b>電脳戦機バーチャロン</b>（<code>vonj.zip</code> と <code>von.zip</code>、または USA 版の <code>von.zip</code> 単体）&mdash; '
        + 'ROM をスキャンして見つけた7097のモデル、10ステージ（一部は部分的）、セル、'
        + '音楽、そしてモーションでポーズをとる9体のロボットが出てきます。',
    'romnote.srallyc': '<b>セガラリーチャンピオンシップ</b>（<code>srallyc.zip</code>、Revision C）&mdash; '
        + '4つのコース、すべてのカラーリングのセリカとデルタ、セル、そしてコース脇で声援を送る観客が出てきます。',
    'romnote.dynamcop': '<b>ダイナマイトコップ</b>（<code>dynamcop.zip</code>、4つのクローンと一緒に）&mdash; '
        + 'ゲーム自身のオブジェクトリストから組み立てた1部屋ずつの279のエリア、19432のモデルすべて、セル、'
        + 'そしてモーションでポーズをとるキャラクターが、2A、2B、2C の基板で出てきます。',
    'romnote.airwlkrs': '<b>エアウォーカーズ</b>（<code>airwlkrs.zip</code>）&mdash; データイーストのゲームです。'
        + 'チームごとに1つ、観客とスコアボードつきの17のコート、'
        + '各チームのユニフォームつきの2026のモデル、セル、そしてモーションでポーズをとる選手が出てきます。',
    'romnote.powsled': '<b>パワースレッド</b>（<code>powsled.zip</code>）&mdash; '
        + 'レースの6つのシーンルーチンを滑走全体にわたって動かして組み立てたただ1つのコース、'
        + 'プログラムが名指す494のモデル、セル、そしてアトラクトのライドシーンが出てきます。',
    'romnote.lastbrnx': '<b>ラストブロンクス</b>（<code>lastbrnx.zip</code>、日本版には <code>lastbrnj.zip</code> を一緒に）&mdash; '
        + 'モデル2544個、ステージ自身のコードで動く9つのステージ（動く仕掛けと曲つき）、508のセル、'
        + 'そしてゲーム自身の格闘コードがポーズをつける、両方のコスチュームの8人のファイターが出てきます。',
    'romnote.pltkids': '<b>パイロットキッズ</b>（<code>pltkids.zip</code>、2A 版には <code>pltkidsa.zip</code> を一緒に）&mdash; '
        + '彩京のゲームです。読み込む9つのシーンのテクスチャつきの4185のモデルすべてと、74のセルが出てきます。',

    'tab.stage': 'ステージ',
    'tab.model': 'モデル',
    'tab.anim': 'アニメーション',
    'tab.cell': 'セル',
    'f.build': 'ビルド',
    'f.stage': 'ステージ',
    'music': '音楽',
    'music.title': 'ステージ自身の音楽を、ゲーム自身のサウンドボードで再生します。68000 のサウンドドライバと'
        + 'その先のサウンドチップをページの中でエミュレートし、ラウンド開始時にゲームが送るコマンドを送ります。'
        + '初回はサウンド ROM（8〜8.5 MB）を zip から読み込みます',
    'music.volume.title': '音量（基板自身のレベルに対して）',
    'music.volume': '音楽の音量',
    'sfx': 'ステージの音',
    'sfx.title': '音楽と一緒に、ステージ自身の効果音 — 観客、鳥、海 — を、ゲームのステージサウンドタスクと'
        + '同じ規則で同じサウンドボードへ送ります。ラウンド開始時に1つ、ステージによってはラウンド中に'
        + 'ランダムにさらに',
    'f.song': '曲',
    'f.zone': 'ゾーン',
    'f.mode': 'ゲームの状態',
    'skyeye': 'ゲームのカメラ <span class="dim">(SKY EYE)</span>',
    'skyeye.title': 'このカメラをゲーム自身のカメラレコード fa_camera として表したもの。デバッグメニューの'
        + ' SKY EYE ページが基板のカメラを動かす数値です。m2-hle2 の SKY EYE モードはこのページのリンク'
        + '（リンクボタンかコピー）から受け取り、このステージの、ここに基板のカメラを置きます',
    'skyeye.copy': 'コピー',
    'skyeye.copy.title': 'ステージとゲームのカメラをテキストとしてコピーします。バグ報告や m2-hle2 の SKY EYE 欄用',
    'lens': '基板のレンズ',
    'lens.title': '基板のレンズで見ます。camera_init は GEO に384ラインの画面で焦点距離280、垂直視野角68.9度を'
        + '与えます。このビューを基板の画像に重ねる前に使ってください',
    'f.layers': 'レイヤー',
    'f.effects': 'エフェクト',
    'f.effects.title': '指定しない限りステージビューが省くもの。基板が自分の時計とカメラで描くエフェクトと、'
        + 'ファイターが起こすもの（代役が演じます）',
    'f.parts': 'パーツ',

    'model.search': 'モデル番号か範囲（例 500-520）',
    'model.onlymesh': 'ジオメトリのあるモデルだけ',
    'f.texset': 'テクスチャセット',
    'f.fightercol': 'ファイターの色',

    'cell.search': 'セル番号、範囲（例 500-520）、unused または名前',
    'cell.cg.title': 'セルと一緒に読み込む CG：タイルのピクセルと、その項目が指す色。すべてを描けるものが先に並びます',
    'cell.under': '先に読み込む',
    'cell.under.title': '上の CG より先に読み込む CG。画面が2つ必要なときのゲームと同じで、2つ目が書くものが1つ目の上に重なります',
    'cell.fit': 'ビューに合わせる',
    'cell.fit.title': 'セルをビューいっぱいに拡大します。オフでは1ピクセルを1ピクセルで描きます',

    'f.fighter': 'ファイター',
    'char.skel': 'スケルトン',
    'char.squish': 'ハンマーでつぶれた',
    'char.travel': 'ルートの移動',
    'char.mirror': '左右反転',
    'char.backward': '逆再生',
    'char.backward.title': 'モーションを最後のフレームから逆に再生します（Air Walkers の選手の +0xEC）',
    'char.rival': '対戦相手',
    'char.behind': '背後',
    'char.rivalp2': '対戦相手 P2',
    'char.p2': 'P2 カラー',
    'f.armour': 'アーマー',
    'f.head': '頭の向き',
    'head.turn': '向き：選手の向きから見た、見ているものの方角（+0xC6）、±67.5°まで',
    'head.tilt': '傾き（+0xC8）、±22.5°まで',
    'f.aim': '照準',
    'aim.twist': 'ひねり：腰の上で相手のほうへ回した上半身（+0x36）',
    'aim.turn': '武器の相手への向き（+0x3A）、±67.5°まで、そのあと高さで±5.6°ずらします',
    'aim.tilt': '武器の上下の傾き（+0x38）、相手のほうへ',
    'vcopaim.yaw': 'プレイヤーへの方位の、体の向きからのずれ（+0x61C − +0x24）。レコードの+0x1Dが2の敵が狙うときのもので、上半身の下で腰と脚がこれだけ回ります',
    'vcopaim.pitch': 'プレイヤーへの傾きの、体の傾きからのずれ（+0x618 − +0x20）',
    'f.wounds': '傷',
    'wounds.title': '各部位が受けた弾の数：一発ごとにその部位の次の傷のモデルを、部位のモデルの代わりに描きます。ヒット（0x68010）が部位の+0に書くとおりです',
    'f.held': '持ち物',
    'held.title': '手に持つもの：右手のモデル（+0x1CC）と左手のモデル（+0x1D0）。敵の自分の持ち物は、出現レコードが与えるものです',
    'pace': 'ペース',
    'pace.title': '選手のペース（+0x16）：モーションの時計はその速さにこれを掛けた速さで進みます。プレー中は少しずつ変わり、選手を作ったときは1です',
    'speed': '速さ',
    'frame': 'フレーム',
    'armour.upper': '上',
    'armour.lower': '下',
    'armour.streak': '100連勝',
    'f.motion': 'モーション',
    'motion.play': '一時停止',
    'f.string': 'ストリング &mdash; 技を続けて',
    'string.next': 'キャンセルフレームで、次に：',
    'string.clear': 'クリア',
    'string.ease': '基板と同じように、各技へなめらかに移る',
    'f.tails': 'テイルスのしっぽ',
    'f.exhaust': 'メタルソニックのジェット',
    'exhaust.open': '入りで噴射口を開く',
    'f.trail': '残像',
    'trail.show': '軌跡を描く',
    'f.osage': '揺れチェーン &mdash; おさげ、しっぽ、羽根',
    'osage.wind': '風',
    'f.slots': 'スケルトンのスロット',
    'note.bodies': 'ボディは <code>0x94E20</code> からのパーツの木で、それぞれ親にぶら下がり、1つの関節の'
        + '3つの角度で回るモデルです。モーションはその角度を毎フレーム焼き込んだもので、先頭にルートの位置が'
        + 'あり、関節数は持っていません。長さから関節数が分かるので、各ボディには自分と同じ関節数用に書かれた'
        + 'モーションが並びます。ゲームはモーションをその場で描き、敵を経路に沿って別に動かします。'
        + '<em>ルートの移動</em>がその経路を見せます。',
    'note.vf2': 'ファイターは <code>0x200620C</code> のレコードで、16個のパーツモデルとそれがぶら下がる'
        + 'スケルトンです。モーション ID は <code>0x2120004</code> のテーブルの添字で、キーフレームは'
        + 'ソニック・ザ・ファイターズが受け継いだ形式です。ポーズは全員共通の標準リグ'
        + '（<code>0x296A0</code>）で解かれ、パーツは基板が描くようにファイター自身のスケルトンに沿って'
        + '置かれます。<em>対戦相手</em>（初期はオフ）は同じモーションの同じファイターで、ラウンド開始時の'
        + '相手の位置、つまりファイターの前に立ちます。<em>背後</em>は代わりにファイターの背中側に立たせます。'
        + '試合でファイターが振り向いた後の位置です。モーションはどちらかを示さないので、振り向くモーションや'
        + '背を向けたモーションでは背後に置くのが合っています。そのとき両者の頭は毎フレーム相手の頭の方を向きます。'
        + 'ゲームがそうするのは試合の状態が許すときだけで、エクスプローラーはそれを追っていないので、'
        + 'オンにするとゲームでは向かない場面でも頭が向くことがあります。',
    'note.fv': 'ファイターは <code>0x640D2B0</code> のレコードで、16個のパーツモデルとそれがぶら下がる'
        + 'スケルトンです。モーション ID は <code>0x6C00004</code> のテーブルの添字で、キーフレームは'
        + 'ソニック・ザ・ファイターズが受け継いだ形式です。ポーズはバーチャファイター2と同じく全員共通の'
        + '標準リグ（<code>0x2C194</code>）で解かれ、パーツはファイター自身のスケルトンに沿って置かれます。'
        + 'ロスターの最後はソニック（モーションの高さの0.56倍で描画、B.M. は1.1倍）、テクスチャのない'
        + 'ダミー2体、別の服のジェーンです。<em>対戦相手</em>をオンにすると両者の頭は毎フレーム相手の頭の方を'
        + '向きます。ゲームがそうするのは試合が許すときだけで、1人のときはモーション自身の目標を追います。',
    'note.dynamcop': 'キャラクターはすべて同じ16関節のスケルトンを持ち、それはテーブルではなくコード'
        + '（<code>0x15210</code>）の中にあります。関節のオフセットは <code>0xE1890</code>、15個のモデルは'
        + ' <code>0xE1A10</code> から、どちらもキャラクター番号で引きます。モーションは毎フレームの16関節の角度と、'
        + 'その後ろのルートの位置です。モーションごとのフラグバイト（<code>0x164160</code>）は足首を、ときには'
        + '手首も、脚や腕と一緒に回さず体に対して水平に保ちます。モーション番号は <code>0x15FA00</code> の'
        + 'テーブルのもので、ゲームに名前はありません。リストの先頭は、そのキャラクターがカットシーンで演じる'
        + 'モーションで、各エリアのアクターリスト（記述子のワード <code>+0xC</code> が指すレコードの'
        + ' <code>+0xFC</code>）から読みます。',
    'note.von': 'ロボットはそれぞれプログラム内のレコード（<code>0x19360</code> のテーブル）で、脚、上半身、'
        + '武器の3つのパーツリストを持ちます。モーションは上半身用と脚用の2つのレコードの組で、毎フレーム'
        + 'パーツごとに3つの角度とオフセットを与えます。ロボットはレコードの <code>+0x70</code> から103組を持ち、'
        + '重複は除き、番号は組の番号です。脚はロボットの立つ位置から、上半身は腰から描かれます。武器は'
        + '試合での照準を除いて手に描かれます。ジグラッドは別のルーチンで描かれるため、ここにはいません。',
    'note.srallyc': 'コース脇の人々です。5、8、12パーツの3体のフィギュアで、パーツはそれぞれ別のモデルとして、'
        + '1つのルーチン（<code>0x5CA290</code>）がフィギュアの原点から置きます。1フレームは各パーツの位置と'
        + '2つの回転で、30フレームあり、ゲームはそれを1フレームに1つずつ往復で再生します。観客がどのフィギュアに'
        + 'なるかは <code>0x5CA280</code> のテーブルから、筐体の稼働日数を30で割って選ばれます。車は車体と4つの車輪のボディです。車輪は <code>0x5C2A80</code> が毎フレーム、'
        + '車の状態から回します。前輪2つはステア（<code>+0x24</code>）、4つとも回転（<code>+0x2C</code>）とサスペンションの'
        + '伸縮（<code>+0x30</code> から）。モーションデータはなく、ここで再生されるのはアトラクトの走行記録で、'
        + '4フレームごとの車の状態を <code>0x28990</code> と同じく補間します。車体はピッチ（<code>+0x18</code>）と'
        + 'ロール（<code>+0x20</code>）で傾き、影は車輪の下の地面（<code>+0x40</code> から）に合わせて傾きます。'
        + '車体のモデルは描画ルーチンが車のフラグ（<code>+0x50</code>）から選ぶものです。「ルートの移動」で走行記録の'
        + 'とおりに走らせ、カメラが追います。砂漠の動物（シマウマ、ダチョウ、鳥、ゾウ）もフィギュアで、'
        + '<code>0x5C70D0</code> が各パーツを3軸で回して描きます。フィギュアごとに時計があり、シマウマの2つは往復し'
        + '（ゲームは両端でランダムに止めますが、ここでは省いています）、ほかはループします。',
    'note.daytona': 'プレイヤーの車です。車体と4つの車輪で、毎フレーム車の状態からコード（<code>0x78C8</code>）が置きます。'
        + '車体は車のロール、向き、ピッチで回ります。<code>0x7DA4</code> が <code>0x230D54</code> の位置に車輪を描き、'
        + '前輪2つはステア、4つとも回転します。影は車体の形を地面に平たく潰したものです。モーションデータはなく、'
        + 'ここで再生されるのはアトラクトの走行記録で、データROMの <code>D.K.</code> テーブルから1フレームに1レコードずつ'
        + '読みます。各コースに2台あり、ステアはそれぞれ専用の2つの記録から取ります。車体は描画ルーチンが'
        + '<code>0x501488</code> から選ぶもので、通信筐体の車はナンバープレートを付けます。'
        + '「ルートの移動」で走行記録のとおりに走らせ、カメラが追います。',
    'note.airwlkrs': '選手はすべて同じ15関節のスケルトンを持ち、それはテーブルではなくコード（脚は <code>0x214A0</code>、'
        + '残りは <code>0x21A70</code>、チーム34は <code>0x20850</code>）の中にあり、エクスプローラーはそのルーチンを'
        + '動かします。選手の16個のモデルは <code>0xF4B20</code> のレコードで、1チーム5人、チーム17からはアウェイの'
        + 'ユニフォームです。モーションは毎フレームの15関節の角度で、データ <code>0x6E3CA0</code> のテーブルから'
        + '読みます。ゲームに名前はありません。手の形はモーションごとに決まります（<code>0xF2C60</code> のレコード）。'
        + '「左右反転」はモーションを左右入れ替えて再生します。選手の動作シーケンス（<code>0x5A300</code>）のステップの'
        + 'ビット12か14が立っているとき、ゲームもそうします。「逆再生」は最後のフレームから最初のフレームへ再生します。'
        + 'ステップのビット13か14（14は両方）が立っているとき、ゲームもそうします。58個のモーションでは頭がプレーの方へ向きます'
        + '（<code>0xB1710</code>）。左右に67.5°まで、傾きは22.5°までです。「頭の向き」でその向きを設定します。'
        + 'ゲームはモーション同士をブレンドしません。新しいモーションは、ここと同じく最初のフレーム（逆再生では最後のフレーム）から始まります。'
        + 'モーションの時計は1描画（1/30秒）に1フレームではなく、レコードの速さ（0x80〜0x4C0、0x100で1フレーム）に'
        + '「ペース」（<code>+0x16</code>）を掛けた分だけ進み、フレームの間はゲームと同じく補間します。',
    'note.vcop': '敵と人質です。ステージのウェーブのレコードが指すボディ（<code>+0x13</code>、<code>0x281EDF0</code> のテーブル）で、'
        + 'それぞれスケルトンと関節ごとのモデルを持ちます。エクスプローラーは、ゲームが敵をウェーブに出すときと同じこと'
        + '（<code>0x13A90</code>）を原点で行い、敵自身の描画（<code>0x21A20</code>）を1フレームずつ実行します。'
        + 'これがモーションの時計を進め、関節をそれぞれ行列にし（<code>0x1F258</code>）、それぞれにモデルを、その下に影を描きます。'
        + 'モーションは <code>0x28188DC</code> のテーブルの1〜170で、ゲームはどれにも名前を付けていません。'
        + 'ステージでどれを再生するかは敵のスクリプト（<code>0x2820D40</code>、<code>0x14118</code> が読みます）が'
        + '撃たれ方と時計で決めます。ボディのリストは、そのレコードのスクリプトが求めるモーションから始まります。'
        + 'ステップはモーションを左右反転で求めることがあり（<code>+0x8A0</code>）、レコードの <code>+0x1D</code> が2の敵は狙います'
        + '（<code>0x15FC0</code>）：プレイヤーへの方位と傾き（<code>+0x61C</code>、<code>+0x618</code>）が体の向きからずれた分だけ、'
        + '上半身の下で腰と脚が回ります。'
        + '描画はスケルトンを外に出さないので、親はフレームから割り出しています。',
    'note.powsled': 'フィギュアです。データROMの10個のテーブルで、それぞれフレームのリストとパーツ数を持ち、'
        + 'パーツはそれぞれ別のモデルです。1フレームはパーツごとの64バイトのレコードで、モデルと描画に使う行列が'
        + '焼き込まれています。<code>0xE1D70</code> がプッシュし、<code>+0x34</code> の位置へ移動し、'
        + '<code>+0x10</code> の3x3を掛け、描いてポップします。親はありません。'
        + 'ゲームはどれにも名前を付けておらず、名前は見えるものを表しています。'
        + '4つのライドは、レース前のライド自身の画面です（モード5、<code>0xE44B0</code> 以降）。'
        + '女性、ライダー、クレーンを、ゲームと同じ位置と時計で置き、ソリはライドの色です（<code>0xE1F30</code>）。'
        + '待機中とエントリー後があります。',
    'note.doa': 'ファイターはエクスプローラーの中で動くゲーム自身の格闘コードで描かれます。アトラクトの試合を'
        + 'プレイヤー1の位置にそのファイターを置いて準備し、プレイヤールーチンと同じようにモーションを始め'
        + '（<code>0x420C0</code>）、毎フレーム、ボディのルーチン（<code>0x457C0</code>）と髪とリボン'
        + '（<code>0x4FEB0</code>）を実行します。モーション ID は <code>0x6000010</code> のテーブル、'
        + '<code>0x552</code> 以降は <code>0x6FC7AC0</code> のテーブルの添字です。ファイター自身の技は、'
        + 'そのアクションスクリプト（<code>0xD8000</code>）が始めるものです。ファイターはモーションどおりに'
        + '踏み出し、髪はそれまでのフレームから揺れます。',
    'note.lastbrnx': 'ファイターはエクスプローラーの中で動くゲーム自身の格闘コードとジオメトリ・コプロのプログラム'
        + '（SHARC インタプリタ上）で描かれます。ファイターをプレイヤー1の位置に、もう一方のコスチュームと向かい合わせて準備し'
        + '（<code>0xB5E10</code>）、モーションを始め（<code>0x49540</code>、ID = 武器セット &lt;&lt; 10 | 技、セットはファイターのレコードのワード12）、'
        + '毎フレーム進めて（<code>0x49820</code>）描きます（<code>0x4A940</code>）。パーツはコプロが書くパケットから読み戻します。'
        + 'モーションの名前、データ、長さは <code>0x52CEA0</code>、<code>0x511BA0</code>、<code>0x52B4D0</code> のテーブルにあります。'
        + '描画はスケルトンを明かさないので、親はフレームから割り出します。',
    'note.stf': 'モーション ID は <code>0x6400004</code> の <code>offset_list_motions</code> の添字です。'
        + 'そのレコードは60チャンネル &mdash; 20オブジェクト &times; 3軸 &mdash; の、定数、線形、または'
        + '3次エルミートのキーフレームを持ちます。12個のオブジェクトは関節の角度で、8個はポーズが向かって'
        + '解かれる点です。リグは単純なチェーンではありません。胸と頭は目標を向き、各手足は目標に届こうと'
        + 'する2ボーンの IK チェーンで、<code>calc_rob_angle_cont</code> がコプロセッサを動かすとおりです。'
        + '<a href="https://github.com/biggestsonicfan/noclip/blob/master/TECHNICAL.md#animation" '
        + 'target="_blank" rel="noopener">Animation</a>（英語）を参照。',

    'f.camera': 'カメラ',
    'cam.orbit': 'オービット',
    'cam.fly': 'Noclip',
    'f.shading': 'シェーディング',
    'shade.lit': 'ライティングしたパレット',
    'shade.flat': 'フラットなパレット',
    'shade.tile': 'テクスチャタイル ID',
    'shade.normals': '法線',
    'f.transfer': 'カラー変換',
    'f.transfer.title': 'シェーディングした色に適用する sRGB 変換。オフが検証済みの既定値です &mdash; '
        + '塗りの経路はすでにディスプレイ基準です。',
    'transfer.off': 'オフ &mdash; ディスプレイ基準',
    'transfer.lin': 'リニア &rarr; ガンマ',
    'transfer.gam': 'ガンマ &rarr; リニア',
    'f.cabinet': 'キャビネット',
    'f.cabinet.title': 'テストメニューの CABINET 設定。ゲームはこれによって2組の定数のどちらかでカラー'
        + 'テーブルを作るので、空も含めて画面のすべての色が変わります。MAME は TWIN で動きます。',
    'f.region': 'リージョン',
    'f.region.title': 'テストメニューの COUNTRY 設定。ステージのモデルのいくつかはこれで選ばれます：'
        + 'ファイティングバイパーズの看板とトラックのキャブ。',
    'opt.anim': 'アニメーション',
    'opt.anim.title': 'ステージのフレームテーブルを基板と同じ 60 Hz で進めます：ヤシの木、カーペットとその'
        + '炎とロープ、フェンス、流れる地平線、海がスクロールするパレットの行、オーロラ・アイスフィールドの'
        + 'カーテンを流れるテクスチャ &mdash; そして空を飛ぶ2つのステージを飛行させます：円を描くフライング'
        + 'カーペット（砂漠とスフィンクスの頭が通り過ぎる）と、峡谷を下るキャニオンクルーズのボート',
    'opt.wire': 'ワイヤーフレーム',
    'opt.grid': 'グリッド',
    'opt.cull': '背面カリング',
    'opt.cull.title': '各ポリゴンを基板が描く側からだけ描きます：ROM の法線をポリゴン自身の点に対して判定し、'
        + '両面と指定されたものは除きます。オフではすべての面を両側から描きますが、基板は決してそうしません',
    'opt.axes': '軸',
    'opt.smooth': '穴をなめらかに',
    'opt.smooth.title': '基板の描き方ではありません。透過テクスチャの穴はテクセル単位で切り抜かれるので、'
        + '点描のもの &mdash; デイトナのタイヤ跡は3分の1が穴です &mdash; はカメラが動くとちらつきます。'
        + '基板でもここでも同じです。これは穴を均一な半透明に平均します',
    'opt.micro': 'マイクロテクスチャ',
    'opt.micro.title': 'カメラが拡大して見えるほど近いとき、面の128x128のディテール用の正方形をテクスチャに'
        + '混ぜます。基板と同じです。ザ・ハウス・オブ・ザ・デッド（プロトタイプも製品版も）は館の壁紙と床の'
        + 'タイルをこれで描き、ここでは他に使うものはありません。オフではテクスチャだけを表示します',
    'opt.fix': 'エラーを修正',
    'opt.fix.title': '出荷時の ROM ではありません。m2emulator によるデイトナのテクスチャ ROM の修正を適用します：'
        + '旗のアニメーション、木、バナーのポール。オフではゲームが実際に持っているバイトを表示します',
    'opt.ride.title': 'ステージを世界の座標ではなく基板自身の座標で見せます：アリーナは止まったまま、世界が'
        + 'その周りを回ります。機械はこの2つをこう描きます &mdash; カメラがカーペットに乗っているのです。'
        + 'どちらでも同じステージで、剛体変換1つ分違うだけなので、互いの位置関係は何も変わりません。'
        + 'オンにすると、止まったばかりのアリーナを、見ていた角度のままカメラに収めます。オフにすると'
        + '立っていた場所に戻ります。動くアリーナを止めて観察するのに使ってください &mdash; たとえば'
        + 'カーペットの波打ちは、固定カメラでは2048フレームの1周を追いかけられません',
    'f.textures': 'テクスチャ',
    'tex.status': 'テクスチャ RAM のダンプを読み込む&hellip;',
    'tex.luma': '輝度',
    'tex.luma.title': 'ジオメトリエンジンが計算するポリゴンごとの輝度に掛けるデバッグ用の係数。1.00 が基板自身の値です',
    'layout.switch': '<span class="desktop-only">スマートフォン</span><span class="mobile-only">デスクトップ</span>のレイアウトに切り替え',

    'fly.hint': '<span class="desktop-only">クリックでマウスをキャプチャ &middot; <b>WASD</b> 移動 &middot; '
        + '<b>Q/E</b> 下/上 &middot; <b>Shift</b> ダッシュ &middot; <b>ホイール</b>か <b>&minus;/=</b> 速度 '
        + '&middot; <b>Esc</b> 解除</span><span class="mobile-only">ビューをドラッグして見回す &middot; '
        + '<b>スティック</b>で移動 &middot; <b>&#9650;&#9660;</b> 上下</span>',
    'touch.move': '移動',
    'touch.up': '上',
    'touch.down': '下',

    'tool.report': '診断情報をコピーして issue を作成',
    'tool.report.title': 'この瞬間の様子を集めてコピーし、新しい issue を開きます（issue は英語でお願いします）',
    'tool.shot': 'ビューのスクリーンショットを保存',
    'tool.export.title': 'ビューにあるモデルを、このフレームで .glb としてエクスポート'
        + '（Blender：ファイル &gt; インポート &gt; glTF 2.0。色を見るには Z &gt; マテリアルプレビュー）',
    'tool.export': 'ビューにあるモデルを .glb としてエクスポート',
    'tool.repo': 'GitHub のリポジトリ',
};

/* What the scripts write, keyed by the English they would write. */
const JA_TEXT = {
    /* app.js: loading */
    'reading {files}…': '{files} を読み込み中…',
    'decompressing {name}': '{name} を展開中',
    '{game} ROM set ready': '{game} の ROM セットの準備完了',
    'unrecognised ROM set — no supported game found in these zips':
        '認識できない ROM セットです — これらの zip に対応ゲームが見つかりません',
    'the file could not be read': 'ファイルを読み込めませんでした',
    'the ROM set loaded, but the 3D view could not start': 'ROM セットは読み込めましたが、3D ビューを開始できませんでした',
    'the set is the right one; the viewer has its chip list but not yet what it needs to draw it':
        '正しいセットです。ビューアーはチップの一覧を持っていますが、描くのに必要なものはまだありません',
    'that chip is in another zip of this set — a MAME clone carries only the chips that are its own and keeps the rest in the parent, so drop the parent\'s zip on as well':
        'そのチップはこのセットの別の zip にあります — MAME のクローンは自分独自のチップだけを持ち、'
        + '残りは親セットに置いているので、親の zip も一緒にドロップしてください',
    'check that these are the ROM zips of a game the viewer knows: {games}':
        'ビューアーが対応しているゲームの ROM zip か確かめてください：{games}',
    'Tick the acknowledgement above before loading a ROM set.':
        'ROM セットを読み込む前に、上の確認にチェックを入れてください。',
    'That is not a .zip — drop the ROM set archive.': 'それは .zip ではありません — ROM セットのアーカイブをドロップしてください。',
    'ROM set already loaded — reload the page to switch it.':
        'ROM セットはすでに読み込まれています — 切り替えるにはページを再読み込みしてください。',
    'The link was for {want}, but these zips are {game} — opened on the default view instead.':
        'リンクは {want} のものですが、これらの zip は {game} です — 代わりに既定のビューで開きました。',
    '{game} — 3D Explorer': '{game} — 3D エクスプローラー',

    /* app.js: textures */
    'sheets unpacked from ROM (sets {sets})': 'ROM から展開したシート（セット {sets}）',
    'sheets unpacked from ROM (set {set})': 'ROM から展開したシート（セット {set}）',
    'sheets unpacked from ROM (sets {sets}, one per part)': 'ROM から展開したシート（セット {sets}、パーツごとに1つ）',
    'sheets unpacked from ROM ({body}\'s, and stage {stage}\'s set)': 'ROM から展開したシート（{body} のセットとステージ {stage} のセット）',
    'the model samples no texture': 'このモデルはテクスチャを使いません',
    'decoding sheets…': 'シートをデコード中…',
    'could not read that dump: {err}': 'そのダンプを読み込めませんでした：{err}',

    /* app.js: the stage panel */
    'draws': '描画',
    'triangles': '三角形',
    'floor size': '床のサイズ',
    'texture set': 'テクスチャセット',
    'colour block': 'カラーブロック',
    'brightness': '明るさ',
    '{n} draws': '描画 {n} 回',
    'Zone': 'ゾーン',
    'Blocks drawn': '描くブロック',
    'ride the arena': 'アリーナに乗る',
    '{n} bands': '{n} 帯',
    'scrolls {n}f': '{n}f でスクロール',

    /* app.js: the model and cell panels */
    '{shown} shown of {n} table entries': 'テーブル項目 {n} 個のうち {shown} 個を表示',
    '{shown} shown of {n} cells': '{n} セルのうち {shown} を表示',
    'cell {n} has no tiles': 'セル {n} にはタイルがありません',
    'From the model (auto)': 'モデルから（自動）',
    'set {n}': 'セット {n}',

    /* app.js: the animation panel */
    'Pause': '一時停止',
    'Play': '再生',
    'Body': 'ボディ',
    'This motion keeps the head straight: its record has no bit 5.': 'このモーションでは頭はまっすぐのままです（レコードのビット5がありません）。',
    'None': 'なし',
    'own: {models}': '自分の持ち物：{models}',
    'model {model}, right hand': 'モデル {model}、右手',
    'model {model}, left hand': 'モデル {model}、左手',
    'left {model}': '左 {model}',
    'A pickup: the game draws it from frame 10 of its pickup action (0x38E), moved 0.05, -0.1 in the hand and 1.2 times the size.': '拾ったもの：ゲームは拾う動作（0x38E）のフレーム10から、手の中で 0.05, -0.1 ずらし、1.2倍の大きさで描きます。',
    "{n} of the body's parts drawn wounded.": '体の部位のうち{n}か所が傷ついた姿です。',
    "None of this body's records has +0x1D 2: the game never aims it this way.": 'この体のレコードには+0x1Dが2のものがなく、ゲームはこの形で狙いません。',
    'This character draws what it holds twice the size.': 'このキャラクターは持ち物を2倍の大きさで描きます。',
    "This robot's weapon does not turn with the aim: its record's +0x484 is 0.": 'このロボットの武器は照準で回りません（レコードの+0x484が0です）。',
    'Fighter': 'ファイター',
    'no wind': '風なし',
    'A string of {n} — built below': '技 {n} 個のストリング — 下で組み立て',
    'Pick a move above, then add to it.': '上で技を選んでから、続く技を追加してください。',
    'then, once free, any move…': '次に、動けるようになったら任意の技…',
    'start with any move…': '任意の技から始める…',
    'Idle': '待機',
    'Its moves, by the input table': '技（入力テーブル順）',
    'The rest of its action table': 'アクションテーブルの残り',
    'What those hand over to': 'それらの次につながるもの',
    'Its intro, win and show poses': '登場、勝利、見せポーズ',
    'Every other motion': 'その他すべてのモーション',
    'Its motions, in its record\'s order': 'レコード順のモーション',

    /* app.js: the hud, the music, the build */
    'noclip camera': 'noclip カメラ',
    'orbit camera': 'オービットカメラ',
    'no music of its own': 'このステージ独自の曲はありません',
    'pick a song': '曲を選んでください',
    'could not start: {err}': '開始できませんでした：{err}',
    '{name} (same colours as {same})': '{name}（{same} と同じ色）',
    'Sega Model 2': 'セガ Model 2',

    /* app.js: more of the above */
    'no 1 MB texture sheet among those {n} file(s) — expected texram0 / texram1':
        'その {n} 個のファイルに 1 MB のテクスチャシートがありません — texram0 / texram1 が必要です',
    'atlas + colour tables from the dump ({n} files)': 'ダンプからのアトラスとカラーテーブル（{n} ファイル）',
    'atlas from the dump, colour tables still built from ROM': 'ダンプからのアトラス、カラーテーブルは ROM から作成',
    'sheets unpacked from ROM ({why})': 'ROM から展開したシート（{why}）',
    'stage slot {n}': 'ステージスロット {n}',
    '{draws} draws · {tris} tris': '描画 {draws} 回 · 三角形 {tris} 個',
    'ride the carpet': 'カーペットに乗る',
    'ride the boat': 'ボートに乗る',
    'tap a part to identify it': 'パーツをタップして識別',
    'click a part to identify it': 'パーツをクリックして識別',
    '{stage}\'s': '{stage} の風',
    'This fighter\'s action slots': 'このファイターのアクションスロット',
    'Every motion in the table ({n})': 'テーブルのすべてのモーション（{n}）',
    'Every motion in the table': 'テーブルのすべてのモーション',
    'Motions its scripts ask for': 'スクリプトが求めるモーション',
    'Every other motion in the table': 'テーブルのその他のモーション',
    'Motions for {n} joints': '関節 {n} 個用のモーション',
    'Driven by this car in the attract': 'アトラクトでこの車が走る記録',
    'Other recorded runs': 'その他の走行記録',
    'Recorded runs': '走行記録',
    'Every other motion for {n} joints': '関節 {n} 個用のその他のモーション',
    'Moves — standing, by the buttons': '技 — 立ち、ボタン順',
    'Moves in other situations': 'その他の状況の技',
    'Draw this cell': 'このセルを描く CG',
    'Others': 'その他',

    /* The stage's layers (stages.js, display.js) */
    'sky': '空', 'water': '水', 'upper': '上部', 'ground': '地面', 'floor': '床', 'platform': '足場',
    'extra': '追加', 'cage': '檻', 'poles': '柱', 'objects': 'オブジェクト', 'scenery': '風景',
    'fighters': 'ファイター', 'outside': '屋外', 'inside': '屋内',

    /* Its record, views and states (stages.js, placements.js, vcop.js, vf2.js, doa.js, daytona.js, dynamcop.js) */
    'stage': 'ステージ', 'course': 'コース', 'blocks': 'ブロック', 'never in view': '一度も見えない',
    'sections': 'セクション', 'zones': 'ゾーン', 'placements': '配置', 'props': '小物',
    'in no reached zone': '到達するゾーン外', 'segments': 'セグメント', 'low detail': '低詳細度', 'pieces': 'ピース',
    'object parts': 'オブジェクトのパーツ', 'flags': 'フラグ', 'routine': 'ルーチン', 'unread': '未解読',
    'area': 'エリア', 'list': 'リスト', 'set': 'セット',
    'Everything': 'すべて',
    'Every segment at once': 'すべてのセグメントを一度に',
    'Every block a car reaches': '車が到達するすべてのブロック',
    'The 5×5 blocks round the camera': 'カメラの周りの 5×5 ブロック',
    'Race': 'レース', 'Attract': 'アトラクト', 'Time attack': 'タイムアタック', 'Ending': 'エンディング',

    /* Effects switches (vf2.js, vf2fx.js) */
    'river shade': '川の日陰',
    'corner objects': 'コーナーのオブジェクト',
    'corner falls (stand-in)': 'コーナーの物が倒れる（代役）',
    'burst (stand-in)': 'バースト（代役）',
    'enemies and hostages': '敵と人質',


    /* report.js */
    'Copied — paste into the issue': 'コピーしました — issue に貼り付けてください',
    'Copy it from the box, then paste': 'ボックスからコピーして貼り付けてください',

    /* splash.js */
    'Clip {i} of {n}: {game}': 'クリップ {i} / {n}：{game}',
};

/* name: the language's name in itself, for the switch. */
export const LANGS = {
    en: { name: 'English', page: {}, text: {} },
    ja: { name: '日本語', page: JA_PAGE, text: JA_TEXT },
};
export const DEFAULT = 'en';
/* Other names a visit may give a language: ?lang=jp is Japanese, as on m2-hle2. */
const ALIASES = { jp: 'ja' };

/* Node (m2-hle2's graders import romset.js, which imports this) has no page:
 * there the text stays English and nothing below touches a document. */
const onPage = typeof document !== 'undefined';
const asked = onPage ? new URLSearchParams(location.search).get('lang') : null;
export const lang = LANGS[ALIASES[asked] ?? asked] ? (ALIASES[asked] ?? asked) : DEFAULT;

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s);

/* `english` in this page's language, its {name}s filled from `vars`. */
export function t(english, vars) {
    return fill(LANGS[lang].text[english] ?? english, vars);
}

/* Put this page's language on everything under `root` that names a key. */
export function apply(root = document) {
    const page = LANGS[lang].page;
    const each = (attr, fn) => root.querySelectorAll(`[${attr}]`).forEach((el) => {
        const s = page[el.getAttribute(attr)];
        if (s !== undefined) fn(el, s);
    });
    each('data-i18n', (el, s) => { el.innerHTML = s; });
    each('data-i18n-title', (el, s) => { el.title = s.replace(/&[a-z]+;/g, decode); });
    each('data-i18n-aria', (el, s) => el.setAttribute('aria-label', s));
    each('data-i18n-placeholder', (el, s) => { el.placeholder = s; });
}

/* A title is an attribute, so the HTML entities the tables share with the
 * markup are spelt out here. */
function decode(entity) {
    const d = document.createElement('textarea');
    d.innerHTML = entity;
    return d.value;
}

/* The page's address in another language: ?lang= set, or dropped for the default. */
export function langHref(code, href = location.href) {
    const url = new URL(href);
    if (code === DEFAULT) url.searchParams.delete('lang');
    else url.searchParams.set('lang', code);
    return url.href;
}

/* The switch in the corner: one link per other language. */
function wireSwitch() {
    const box = document.getElementById('tool-lang');
    if (!box) return;
    for (const [code, L] of Object.entries(LANGS)) {
        if (code === lang) continue;
        const a = document.createElement('a');
        a.href = langHref(code);
        a.lang = code;
        a.textContent = L.name;
        box.appendChild(a);
    }
    box.hidden = false;
}

if (onPage) {
    document.documentElement.lang = lang;
    if (lang !== DEFAULT) {
        apply();
        const title = LANGS[lang].page['doc.title'];
        if (title) document.title = title;
    }
    wireSwitch();
}
