<p align="center">
  <img src="docs/top.webp" alt="ComfyUI-Drawer" width="100%">
</p>

<h3 align="center">モバイルでも扱いやすい ComfyUI 用モジュラー UI プラットフォーム</h3>

<p align="center">
  <a href="#comfyui-drawer-とは">概要</a> •
  <a href="#なぜ-drawer">なぜ Drawer?</a> •
  <a href="#インストール">インストール</a> •
  <a href="#サンプルワークフロー">サンプル</a> •
  <a href="#ビルトインガジェット">ガジェット</a> •
  <a href="#ワークフロー補助機能">補助機能</a> •
  <a href="#共通-ui-システム">共通 UI</a> •
  <a href="#drawer-ノード">ノード</a> •
  <a href="#開発者エージェント向け">開発</a> •
  <a href="CHANGELOG.md">更新履歴</a> •
  <a href="LICENSE">ライセンス</a>
</p>

<p align="center">
  <a href="README.md">English</a> •
  <a href="README_zh.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg" alt="License: GPL-3.0-or-later">
  <img src="https://img.shields.io/badge/ComfyUI-Custom_Node-purple.svg" alt="ComfyUI Custom Node">
  <img src="https://img.shields.io/badge/lang-en%20%7C%20ja%20%7C%20zh-green.svg" alt="Languages: en, ja, zh">
</p>

---

## 機能デモ

https://github.com/user-attachments/assets/a9ba848f-11eb-42f7-9fc8-31616ed82df5

注: このデモには ComfyUI-Drawer に含まれない外部カスタムノードが含まれています。

---

## ComfyUI-Drawer とは

ComfyUI-Drawer は、複雑な ComfyUI ワークフローを、コンパクトでタッチしやすい操作パネルに変換する拡張です。

ノードグラフはそのままに、実際に触りたいパラメータだけを取り出し、出力画像・モデル素材・マスク・パラメータスイープまで下部 Drawer に集約します。

Drawer 内はモジュール式になっており、ワークフロー操作、メディア管理、モデル閲覧、プロット系ツール、独自拡張を同じ場所にまとめられます。

---

## なぜ Drawer?

デスクトップでは、ComfyUI-Drawer は ComfyUI キャンバスにリモコンのような操作レイヤーを追加します。ノードグラフは開いたまま、実際に触るパラメータ、素材、確認ツールを下部 Drawer から操作できます。

モバイルや小さな画面では、その Drawer 自体がメインの作業面になります。パラメータ操作、出力確認、モデル閲覧、マスク編集、プロンプト辞書、XYZ 検証を手元にまとめることで、制作中の操作を実用的にします。

APP mode とは異なり、Drawer はワークフローを別アプリ化せず、編集・検証・試行錯誤を続けるための UI として設計されています。

---

## インストール

### ComfyUI-Manager 経由（推奨）

[ComfyUI-Manager](https://github.com/ltdrdata/ComfyUI-Manager) のインストールメニューで **ComfyUI-Drawer** を検索。

### 手動インストール

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Kuroi961/ComfyUI-Drawer.git
pip install -r ComfyUI-Drawer/requirements.txt
```

---

## サンプルワークフロー
<p align="left">
  <img src="docs/sample.webp" width="50%">
</p>
ComfyUI のテンプレート画面から、ComfyUI-Drawer のサンプルワークフローを開けます。

- `drawer-sample-anima` — Drawer の基本的な使い方を含むサンプル
- `drawer-sample-anima-advanced` — 外部カスタムノードを含むより実践的なワークフロー（追加のモデルとノードが必要です: `rgthree-comfy`, `comfyui-impact-pack`, `comfyui-ppm`, `comfyui-kjnodes`, `comfyui-easy-use`, `seedvr2_videoupscaler`）
- `drawer-tutorial-deck-ja` / `drawer-tutorial-deck-en` / `drawer-tutorial-deck-zh` — ノードをどのように Deck に表示するかのチュートリアル

---

## ビルトインガジェット

ComfyUI-Drawer では、Drawer 内で動作する各ツールを**ガジェット**と呼びます。

### Deck
<p align="left">
  <img src="docs/deck.webp" width="50%">
</p>
ワークフローのパラメータを簡易的に操作するガジェットです。

**表示の制御方法：**

ノードまたはグループのタイトルに**マーカー**を追加することで表示を制御します。

| マーカー | 対象 | 効果 |
|---------|------|------|
| `📝` | ノードタイトル | そのノードのウィジェットが Deck のメイン画面に表示される |
| `⚡` | ノード or グループタイトル | バイパスを ON/OFF するスイッチが追加される |
| `[ラベル]` | ノード or グループタイトル | 同じラベル間で排他的にバイパスを切り替える |

ノードは Y 軸順(上から下)、グループは X 軸順(左から右)にソートされます。

**その他の仕様：**
- グループは、表示可能なノードを 1 つでも含んでいれば常にセクションとして表示される
- グループに属さないノードはその他としてまとめて最後に表示される
- 左下のボタンから `📝` を含まないノードを表示できる

---

### XYZ Plot
<p align="left">
  <img src="docs/xyzplot.webp" width="50%">
</p>

https://github.com/user-attachments/assets/64fbe663-8f16-4f4c-b9b1-0ae5173eb9a1

Stable Diffusion web UI（A1111）でお馴染みの、パラメータを変えながら連続生成するガジェットです。概ね A1111 の挙動に準拠しています。

専用の XYZ ノードや追加配線は不要です。現在のワークフローにあるウィジェットやバイパス状態をそのままスイープできます。

**基本機能：**

- 任意のノードの任意のウィジェットを X/Y/Z の各軸に指定して連続生成
- テキストウィジェットに対しては Prompt S/R（Search & Replace）モードが自動的に適用される
- バイパス軸 — ノード単体の ON/OFF、Deck のグループトグル、グループ排他、ノード排他をスイープ軸として使用可能
- 軸ラベル付きのグリッド合成画像を自動生成し、output に保存

**技術詳解：**

| 項目 | 詳細 |
|------|------|
| **キューロック** | スイープ中は `app.queuePrompt` をモンキーパッチして外部からのキュー投入をブロック。スイープ完了後に復元 |
| **シード固定** | スイープ開始時に全ウィジェットのスナップショットを取得。各イテレーションの前にスナップショットを復元し、その上から軸の値を適用|
| **DrawerSeed 連携** | スイープ直前にランダム化を一度だけ実行し、スイープ中は `window.__xyzSweepActive` により DrawerSeed の queue hook による再ランダム化を抑制 |
| **batch_size 強制** | スイープ対象外の `batch_size` ウィジェットは自動的に `1` に強制。`control_after_generate` は `fixed` に強制 |
| **プリフライト検証** | スイープ開始前にウィジェットの型と値範囲を検証し、ミスマッチがあれば警告を表示 |
| **サーバー切断検知** | WebSocket の `status`/`reconnecting` イベントを監視し、サーバー切断時にスイープを即座に中断 |
| **ワークフロー埋め込み** | 合成画像に PNG PngInfo または JPEG/WebP EXIF としてワークフロー JSON を埋め込み |

---

### Gallery
<p align="left">
  <img src="docs/gallery.webp" width="75%">
</p>
output、input、temp フォルダ配下のメディアやフォルダをブラウズするガジェットです。

- フォルダナビゲーション（パンくずリスト）、ソート（名前/日時/サイズ）
- ファイルのリネーム・移動（D&D/バッチ選択）・削除
- ファイル名検索はインデックスなしで利用可能。prompt、workflow、ノードタイプ、ノードタイトル単位のメタデータ検索には、明示的に作成した SQLite 検索インデックスを使用
- 検索は引用符付きフレーズ、スペース区切りの AND、`-word` / `-"quoted phrase"` による NOT 指定に対応
- `type:CLIPTextEncode[white hair -night]` のような構文で、特定ノードタイプ内の値を検索可能。`[...]` はそのノードタイプ内の値だけを対象にする仮想検索欄として扱われ、通常の検索欄と同じフレーズ / AND / NOT ルールを利用できます
- `title:My Prompt Node[school uniform]` や `title:"Prompt A"[blue sky]` のように、ノードタイトルで絞り込む検索にも対応。タイトル部分はノードタイトルに対して一致し、`[...]` は一致したタイトルのノード内の値を検索します
- 検索対象、日付範囲、ファイルサイズのフィルターに対応し、モバイル向けの2段検索ツールバーで操作可能
- Gallery の検索欄でも、ノードタイプ、ユーザー辞書、Danbooru 辞書のオートコンプリートを利用可能
- 新規フォルダ作成、フォルダごとの移動・削除

---

### Model Viewer
<p align="left">
  <img src="docs/modelviewer.webp" width="25%">
</p>
（実際にはモデル名の下にパスが表示されます）

ComfyUI の models フォルダ、および `extra_model_paths.yaml` で追加されたモデルパス配下のモデルやフォルダをブラウズするガジェットです。

- 全モデルタイプ対応（checkpoints, loras, vae, embeddings, controlnet, upscale_models 等）
- **CivitAI 同期** — SHA256 ハッシュによるモデル照合でメタデータ＆プレビュー画像を取得可能（`.red` / `.com` フォールバック対応）
- **ノードマッチング** — **インフォカード**から、ワークフロー内の対応するローダーノードに適用可能（サブグラフ、Combo Clone、接続済み DrawerControls も含む全ノードをスキャン）
- **トリガーワード** — CivitAI の `trainedWords` を自動表示。カスタムワードの追加も可能（LoRA のみ）
- サムネイル（サイドカー画像）対応。output 画像からの設定/削除付き
- 動画プレビュー（`.mp4` / `.webm`）のグリッド＆インフォカード表示
- モデルごとのユーザーメモ（`.drawer.json` に永続化）

---

## ワークフロー補助機能
<p align="left">
  <img src="docs/others.webp" width="50%">
</p>

### ユーザー辞書＆ワイルドカード
プロンプト入力補完用の辞書サービスが内蔵されています。

https://github.com/user-attachments/assets/34237d5e-cd92-4a8e-a638-cb6d98256536

- **Danbooru タグ辞書** — 使用頻度付きのタグデータベース（CSV）
- **ユーザー辞書** — タグ → 挿入テキストのカスタムマッピングを作成可能
- **ワイルドカード** — `__名前__` 構文でリストからランダム選択
- **CSV / TXT インポート** — 既存のタグファイルをインポート可能
- **コメント構文** — `//`、`#`、`/* */` でプロンプトの一部をコメントアウト
- **ノード不要** — ワイルドカード展開とコメント除去はキュー投入時に自動適用

設定パネルから辞書の作成・編集・ON/OFF が管理できます。ワークフローにワイルドカード用ノード、辞書用ノード、前処理ノードを追加する必要はありません。通常のプロンプトノード、DrawerControls 経由のテキスト、その他の文字列ウィジェットに対して、ComfyUI のキュー投入時にコメント除去とワイルドカード展開が自動的に適用されます。

**プロンプト処理の仕様：**

- `__名前__` は、有効化されている同名のワイルドカード辞書から 1 行を選んで展開される
- 展開はワークフロー内の `seed` / `noise_seed` / `seed_value` を元に決定される。シードが見つかった場合は同じシードで同じ展開になり、見つからない場合は通常のランダム選択になる
- コメントは実行用プロンプトから除去されるが、出力画像に埋め込まれるワークフロー情報にはコメントを残す
- `/* ... */` はブロックコメント、`// ...` は行コメント、行頭の `# ...` も行コメントとして扱う
- `\#` や `\/` のようにエスケープした記号は、コメント開始ではなく通常の文字として扱う

**CSV / TXT インポートの書式：**

ユーザー辞書は CSV、ワイルドカードは TXT としてインポートします。CSV は 1 行目にヘッダーが必要です。

```csv
tag,insert_text
sky,"blue sky, clouds"
masterpiece,"masterpiece, best quality"
```

- `tag` は補完候補として表示される名前
- `insert_text` は選択時に実際に挿入される文字列。空の場合は `tag` 自体が使われる
- カンマを含む値は、通常の CSV と同じくダブルクォートで囲む

ワイルドカード用 TXT は 1 行につき 1 候補です。インポートしたファイル名、または設定画面で付けた辞書名が `__名前__` の名前になります。

```txt
blue sky, sunlight
night city, neon lights
soft backlight, floating particles
```

- 空行は無視される
- 行頭が `#` または `//` の行は、ワイルドカード候補としては使われない
- ワイルドカードの再帰展開は行わない。候補の中に `__別名__` を書いた場合は、その文字列がそのまま残る
- コメント内に書かれたワイルドカードは展開されない

### マスクエディタ

画像のコンテキストメニューから開けるフルスクリーンのシンプルなマスク編集UI。生成したマスクは `input/drawer_masks` に保存され、`LoadImageMask` ノードへ直接適用できます。

---

## 共通 UI システム

### コンテキストメニュー

右クリック/ロングタップで展開可能なメニュー。新しいタブで開く、LoadImage / LoadImageMask に送る、ワークフローとして開く、ダウンロード等。ガジェットごとに独自のメニュー項目を登録可能。

### ライトボックス

画像・動画・音声に対応するフルスクリーンメディアビューア。Gallery、Deck、XYZ Plot、共通メディアカードから開けます。

- キーボード（←→ / A/D）、スワイプ、ボタンでの前後ナビゲーション
- 現在の画像をクリック、またはコンテキストメニューから新しいタブで開く
- ライトボックスから画像をドラッグしてキャンバスにドロップ可能
- コンテキストメニュー対応（ライトボックス内でも右クリック/ロングタップが使える）

### ポップアップ＆ダイアログ

`showAlert`、`showConfirm`、`showPrompt`、`showDialog` の 4 種類を提供。

### ファイルピッカー

メディアファイル選択用のモーダルピッカー。画像・動画・音声の選択に対応。サムネイル付きフォルダナビゲーションを内蔵。

### 多言語対応

英語・日本語・中国語（簡体字）に対応。ComfyUI の設定 > Locale に連動して自動的に言語が切り替わります。

---

## Drawer ノード

一部Deck上での専用UIを持つユーティリティノードを 9 個搭載しています。

| ノード | 説明 |
|--------|------|
| **DrawerSeed** | ランダム/固定モード付き |
| **DrawerControls1 / 4 / 8 / 12** | コンパクトなパラメータハブ。接続済みの出力だけが Deck 上の `int` / `float` / `combo` / `bool` / `string` コントロールとして表示されます。単行は `string \| ラベル`、複数行は `string \| ラベル \| multiline` を使い、combo 候補は接続先 widget から取得されます |
| **DrawerConcat** | 可変長のテキスト入力を任意の区切り文字で結合 |
| **DrawerSize** | 解像度プリセット（横長/縦長/正方形）から width/height を出力 |
| **DrawerSwitch** | 任意データ型の A/B スイッチ。B が接続済みかつ非空なら B、そうでなければ A を返す。ComfyUI V3 API による遅延評価で、不要な側のサブグラフは実行されない |
| **DrawerSwitchChain** | 可変長のフォールバックチェーン。後ろ側の接続済み・非空値が優先される |

---

## 開発者/エージェント向け

ComfyUI-Drawer は拡張可能なプラットフォームとして設計されています。**1 ファイルで完結するガジェット**を作成できます：

1. [docs/gadget-template.js](docs/gadget-template.js) をコピー
2. 任意の `custom_nodes/*/web/js/` フォルダに配置（ComfyUI-Drawer 自体でなくても OK）
3. クラスを書き換えて ComfyUI を再起動

```js
import { app } from "../../../scripts/app.js";

app.registerExtension({
    name: "Comfy.Drawer.MyGadget",
    async setup() {
        const drawer = window.ComfyDrawer ?? await new Promise(resolve =>
            window.addEventListener('comfy-drawer:ready', e => resolve(e.detail), { once: true })
        );
        const { GadgetBase } = drawer;

        class MyGadget extends GadgetBase {
            constructor() {
                super('my-gadget', { label: 'My Gadget', icon: '🔧', order: 10 });
            }
            onMount(container, bus, bridge) {
                container.innerHTML = '<p>Hello World</p>';
            }
        }

        drawer.registerGadget(new MyGadget());
    },
});
```

- `window.ComfyDrawer` から `GadgetBase`, `bus`, `bridge`, `settings`, `dict` 等の全サービスにアクセス可能
- CSS は `<style>` タグで直接注入（`@layer gadget-<id>` でスコーピング推奨）
- 外部パッケージからの import は `app.js` のみ。Drawer 内部モジュールへの依存ゼロ

完全な API リファレンスは [GADGET_API.md](GADGET_API.md) を参照してください。

| ドキュメント | 説明 |
|-------------|------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | プラットフォーム設計、モジュール責務、設計決定ログ |
| [CONVENTIONS.md](CONVENTIONS.md) | コードスタイル、CSS スコーピング、命名規約 |
| [GADGET_API.md](GADGET_API.md) | ガジェット開発 API リファレンス |

---

## このプロジェクトについて

ComfyUI-Drawer は、人間による指示・レビュー・テストのもと、100% AI によってコーディングされています。

---

## ライセンス

ComfyUI-Drawer はライセンスを分けています。

- 実装本体: [GPL-3.0-or-later](LICENSE)
- 公開仕様ドキュメント（`ARCHITECTURE.md`, `CONVENTIONS.md`, `GADGET_API.md`）: CC0-1.0
- ガジェットテンプレート（`docs/gadget-template.js`）: MIT

© 2026 Kuroi
