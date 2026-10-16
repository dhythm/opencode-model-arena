# GLM Board ⚡

**OpenCode + GLM-5.3-Flash（Free Model）による性能検証用のリアルタイム同期カンバンボードアプリ。**

Node.js のみ（**npm 依存ゼロ**）でフルスタックを構築しています。

## 特徴

- **バックエンド**: Node.js 組み込み `http` モデルのみの REST API + SSE（Server-Sent Events）によるリアルタイム配信
- **フロントエンド**: バニラ JS / CSS。ビルド不要
- **リアルタイム**: 他ブラウザでの操作が即座に全接続クライアントへ同期
- **ドラッグ&ドロップ**: HTML5 DnD API でタスクをカラム間移動
- **永続化**: JSON ファイルへのアトミック書き込み（デバウンス付き）、再起動後も復元
- **堅牢性**: パストラバーサル対策、ボディサイズ上限、バリデーション、統一エラーレスポンス
- **テスト**: Node 組み込み `node:test` による API 結合テスト 17 件（SSE・永続化・不正入力含む）

## 起動

```bash
npm start          # ポート3000（既定）
PORT=3457 npm start
```

ブラウザで `http://localhost:3000` を開く。

## テスト

```bash
npm test
```

## API

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/health` | ヘルスチェック |
| GET | `/api/board` | ボード全体（カラム+タスク） |
| GET | `/api/stats` | 統計（件数・完了率） |
| GET | `/api/events` | SSE イベントストリーム |
| POST | `/api/columns` | カラム作成 |
| PATCH | `/api/columns/:id` | カラム名変更 |
| DELETE | `/api/columns/:id` | カラム削除（タスクも削除） |
| POST | `/api/tasks` | タスク作成 |
| PATCH | `/api/tasks/:id` | タスク更新（移動・完了・並び替え） |
| DELETE | `/api/tasks/:id` | タスク削除 |

## 構成

```
GLM-5.3-Flash/
├── server/
│   ├── app.js     # HTTPサーバ + REST API + SSE
│   └── store.js   # JSON永続化ストア（アトミック書き込み）
├── public/
│   ├── index.html # アプリシェル
│   ├── style.css  # ダーク/ライトテーマ対応スタイル
│   └── app.js     # レンダリング・DnD・SSEクライアント
├── test/
│   └── api.test.js
└── data/          # 実行時に生成される保存データ
```
