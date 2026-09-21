# 🏋️ 健身追踪器 (Fitness Tracker)

一个轻量级的健身训练日志应用程序，帮助你轻松记录和追踪每次训练的细节。支持多种肌肉群训练，自动保存进度，并提供历史记录查询功能。

## ✨ 项目特性

- **直观的用户界面**: 简洁明了的界面，易于上手和操作。
- **多肌肉群支持**: 轻松切换不同肌肉群的训练（胸、背、肩、腿）。
- **实时训练记录**: 方便地添加多个动作和每组的重量、次数。
- **训练进度自动保存**: 无需手动点击保存，所有输入都会自动同步到浏览器本地存储（LocalStorage），防止意外退出丢失数据。
- **历史记录**: 查看和管理过去的所有训练会话，帮助你追踪进步。
- **删除历史记录**: 支持删除单次历史训练记录。
- **自定义动作**: 可以添加新的训练动作到指定肌肉群，方便扩展。
- **响应式设计**: 兼容手机和桌面浏览器，提供一致的用户体验。
- **后端 API**: 基于 Cloudflare Workers，提供快速、可靠的数据存储和检索。
- **数据持久化**: 使用 Cloudflare D1 数据库存储训练数据。

## 🚀 部署指南

本项目的前端部署在 Cloudflare Pages，后端 API 部署在 Cloudflare Workers，数据存储使用 Cloudflare D1。

### 准备工作

在开始部署之前，你需要：

1. **一个 Cloudflare 账号**: 如果你还没有，请前往 [Cloudflare 官网](https://www.cloudflare.com/) 注册。
2. **安装 Git**: 用于克隆项目代码。
3. **安装 Node.js 和 npm**: 我们将使用 `npm` 来安装 Workers 和 Pages 的命令行工具。

#### 手把手教学：安装 Node.js 管理工具 NVM

`nvm` (Node Version Manager) 是一个非常方便的工具，可以让你在同一台机器上轻松安装和切换不同版本的 Node.js。强烈推荐使用它来管理 Node.js 环境。

**macOS/Linux 安装 NVM:**

1. **打开终端**。

2. **下载并运行安装脚本**:

   ```
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
   ```

   (请注意：`v0.39.7` 是当前最新版本，你可以在 [NVM GitHub 仓库](https://github.com/nvm-sh/nvm) 查看最新版本号并替换。)

3. **重启终端** 或 **手动加载 NVM**: 通常安装脚本会提示你需要在 `.bashrc`, `.zshrc`, 或 `.profile` 文件中添加一些配置。按照提示操作，然后关闭并重新打开终端。如果 NVM 命令仍然找不到，可以尝试运行：

   ```
   source ~/.bashrc # 或者 ~/.zshrc，根据你的shell类型
   ```

4. **验证 NVM 安装**:

   ```
   nvm --version
   ```

   如果显示版本号，说明安装成功。

**Windows 安装 NVM:**

Windows 用户推荐使用 [nvm-windows](https://github.com/coreybutler/nvm-windows)。

1. **下载安装包**: 访问 [nvm-windows GitHub Releases 页面](https://github.com/coreybutler/nvm-windows/releases)，下载最新的 `nvm-setup.zip` 文件并解压。

2. **运行安装程序**: 运行解压后的 `.exe` 安装程序，按照提示完成安装。

3. **验证 NVM 安装**: 打开新的命令提示符或 PowerShell 窗口，运行：

   ```
   nvm version
   ```

   如果显示版本号，说明安装成功。

#### 使用 NVM 管理 Node.js 版本

安装 NVM 后，你可以：

1. **安装最新 LTS (长期支持) 版本**:

   ```
   nvm install --lts
   ```

2. **使用指定版本 (例如 v18)**:

   ```
   nvm use 18
   ```

3. **查看已安装版本**:

   ```
   nvm ls
   ```

4. **设置默认版本**:

   ```
   nvm alias default <version_number> # 例如: nvm alias default 18
   ```

**建议**: 使用 NVM 安装 Node.js **最新 LTS 版本** 即可。

### 1. 克隆项目代码

首先，将项目代码克隆到你的本地机器：

```
git clone <你的项目仓库URL> # 替换为你的GitHub仓库URL
cd <项目目录> # 进入项目目录
```

### 2. 设置 Cloudflare D1 数据库 (后端数据)

首先，确保您已经安装了 Wrangler CLI。

```bash
npm install -g wrangler
```

Cloudflare D1 是一个基于 SQLite 的全球分布式数据库，非常适合 Workers 使用。

**1. 创建 D1 数据库:** 如果您还没有 D1 数据库，可以通过 Wrangler 创建：

```bash
wrangler d1 create fitness-data
```

记下 `database_id`，并将其粘贴到 `wrangler.toml` 中。

**2. 应用数据库模式:** 项目根目录中的 `Schema.sql` 是完整初始化脚本，使用 Wrangler 应用它：

```bash
wrangler d1 execute fitness-data --remote --file=./Schema.sql
```

如果数据库已经存在，再依次执行同步字段和索引迁移：

```bash
npm run migrate:sync
npm run migrate:indexes
```

### 3. 部署后端 API (Cloudflare Workers)

本项目后端是一个简单的 API，用于管理训练动作和会话数据。

1. ** `wrangler.toml` 文件**: 项目根目录下的 `wrangler.toml` 是 Cloudflare Workers 配置文件。

   ```ini
   name = "fitness-tracker-api" # 你的Worker名称，全局唯一
   main = "src/index.js"
   compatibility_date = "2024-07-14" # 使用当前日期或未来日期
   
   [[d1_databases]]
   binding = "DB" # 这是你在Worker代码中访问D1数据库的变量名 (例如 env.DB)
   database_name = "fitness-tracker-db" # 你在D1 Dashboard中创建的数据库名称
   database_id = "<你的D1数据库ID>" # 替换为你在D1 Dashboard复制的数据库ID
   ```

   **重要**: 将 `<你的D1数据库ID>` 替换为你在 Cloudflare D1 Dashboard 中复制的实际数据库 ID。

2. **登录 Cloudflare**: 在终端中运行：

   ```
   wrangler login
   ```

   这会打开一个浏览器窗口，让你登录 Cloudflare 账号并授权 Wrangler。

3. **部署 Workers**: 在项目根目录执行：

   ```
   wrangler deploy
   ```

   这会将你的 Workers 代码部署到 Cloudflare。部署成功后，你会得到一个 Workers 的 URL，例如 `https://fitness-tracker-api.<你的子域名>.workers.dev`。

   **记住这个 URL，你需要在前端代码中配置它。**

### 4. 部署前端 (Cloudflare Pages)

前端是一个纯 HTML/CSS/JavaScript 应用，可以使用 Cloudflare Pages 快速部署。

1. **在 Cloudflare Dashboard 中创建 Pages 项目**:

   - 登录 Cloudflare Dashboard。
   - 点击 **"Workers & Pages"** -> **"Pages"**。
   - 点击 **"Create a project"**。
   - 选择 **"Connect to Git"** (推荐) 或 **"Direct Upload"**。
   - 如果你选择 Git：
     - 连接你的 GitHub 账号，选择你的项目仓库。
     - 配置构建设置：
       - **Build command**: 留空（或如果你有构建步骤，例如 `npm run build`，则填写）
       - **Build output directory**: 留空（或如果你有构建产物目录，例如 `dist`，则填写）。本项目前端是单个 HTML 文件，不需要特定构建目录。
       - **Root directory**: `/` (默认)
     - 点击 **"Save and Deploy"**。
   - 如果你选择 Direct Upload：
     - 将你的 `index.html` 文件**压缩zip后**上传。

   **index.html在public文件夹中**

2. **配置公共动作管理员**: 在 Cloudflare Worker 的环境变量中设置 `COMMON_EXERCISE_ADMIN_IDS`，填写逗号分隔的 GitHub 用户名或 GitHub 数字 ID。未配置时公共动作保持只读。

3. **更新前端 `index.html` 中的 API_BASE_URL**: 使用 `npm run deploy:frontend` 部署时，脚本会临时注入生产 API 地址；本地文件保持空地址。

   本地源码中的 API 地址保持为空；部署脚本会临时注入实际的 Workers URL。API 地址必须以 `/api` 结尾，因为 Worker 使用 `/api` 作为路由前缀。

4. **重新部署 Pages**: 如果你是 Git 部署，修改 `index.html` 并推送到你的 Git 仓库，Pages 会自动触发重新部署。 如果你是直接上传，则需要重新上传修改后的 `index.html` 文件。

### 5. 运行项目

完成上述部署步骤后：

1. 打开你的 **Cloudflare Pages 项目域名**（例如 `https://your-fitness-tracker.pages.dev`）。
2. 你的健身追踪器应用应该已经可以正常访问和使用了。

## 🤝 贡献

欢迎对本项目提出建议和贡献！如果你发现 bug 或有新功能想法，请提交 issue 或 Pull Request。
