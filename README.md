# 四季轮转

《四季轮转》是一个实时 3D 动画。黑白两只猫在唱片形的草地上活动，草地随唱片转动经历四季。

## 本地预览

在 P5 目录启动本地服务。

```bash
python3 -m http.server 5173 --bind 127.0.0.1
```

打开 <http://127.0.0.1:5173/>，或直接访问 <http://127.0.0.1:5173/seasons/>。项目使用本地 Three.js，无需安装依赖或构建。

## 通过 GitHub 自动部署到 Cloudflare

将项目推送到 GitHub 的 `main` 分支。在 Cloudflare 控制台进入 **Workers & Pages**，创建应用时选择 GitHub 并连接该仓库。已有 Worker 时可在 **Settings → Builds** 中连接。[Cloudflare Git 构建指南](https://developers.cloudflare.com/workers/ci-cd/builds/)

| Cloudflare 设置 | 值 |
| --- | --- |
| Worker 名称 | `four-seasons-meadow` |
| 生产分支 | `main` |
| 根目录 | 仓库根目录 |
| 构建命令 | `node scripts/build.mjs` |
| 部署命令 | `npx wrangler deploy` |

Worker 名称须与 `wrangler.jsonc` 中的 `name` 一致。该配置会将构建生成的 `dist/` 用作静态资源目录。保存并部署后，往 `main` 推送更新会触发新的构建和部署。[构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

## 本地构建与手动部署

在项目根目录运行构建命令。`dist/` 包含站点入口、场景模块、样式和本地 Three.js，开发截图和动图放在 `seasons/artifacts/`。

```bash
node scripts/build.mjs
```

### Workers Static Assets

`wrangler.jsonc` 将 `dist/` 设为静态资源目录，默认项目名为 `four-seasons-meadow`。如需使用自己的项目名，可编辑其中的 `name`。登录 Cloudflare 后运行部署命令。部署完成后，Wrangler 会输出站点地址。[Cloudflare Workers 静态站点指南](https://developers.cloudflare.com/workers/static-assets/get-started/)

```bash
npx wrangler login
npx wrangler deploy
```

### Pages 直接上传

在 Cloudflare 控制台的 **Workers & Pages** 中创建 Pages 的直接上传项目，上传 `seasons-cloudflare.zip` 或 `dist/` 文件夹。上传 ZIP 时，`index.html` 应位于压缩包顶层。直接上传和 Git 自动构建是在创建 Pages 项目时选择的两种模式。[Cloudflare Pages 直接上传指南](https://developers.cloudflare.com/pages/get-started/direct-upload/)

重新打包时使用以下命令。生成 ZIP 需要系统提供 `zip` 命令。

```bash
node scripts/build.mjs --zip
```

## 场景与预览素材

操作方式、场景实现和预览素材见 [《四季轮转》项目说明](seasons/README.md)。
