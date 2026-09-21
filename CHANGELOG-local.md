# 本地修复日志

## 2026-09-21

- 建立分支 `fix/security-data-integrity`。
- 建立 `ISSUES.md`，记录数据库初始化、用户隔离、XSS、权限、依赖和测试问题。

### 数据库与同步隔离

- `Schema.sql` 增加 `common_exercises`、同步字段、索引和幂等种子数据；旧数据库通过 `migrations/002_add_sync_fields.sql` 兼容升级。
- 同步、历史、自定义动作查询和写入均增加当前用户归属条件；匿名旧记录保留但不再自动认领或展示。
- 公用动作改为全局只读，新增、修改、删除必须通过 `COMMON_EXERCISE_ADMIN_IDS` 白名单授权。
- 验证：空 SQLite 数据库初始化成功；旧结构执行 002/003 迁移成功；跨用户 UID 更新保护和管理员权限测试通过。

### 前端安全与体验

- 动作列表、下拉选项、公用动作管理和用户区域改用 DOM API / `textContent`；动作名称、用户名称、头像 URL 和历史提示内容不再直接信任 HTML 字符串。
- 首页重做为 iOS Liquid Glass 视觉系统：优先使用 SF Pro / PingFang 系统字体、iOS system blue/indigo/cyan 色彩、半透明面板、高斯模糊、细亮边、分层阴影和自适应浅色/深色主题；训练入口增加编号、训练类型和信息层级。
- 动效按 iOS 风格处理：页面柔和入场、卡片错峰出现、按压回弹、悬浮形变、主题圆形过渡、底部弹窗浮起；支持 `prefers-reduced-motion` 和 `prefers-reduced-transparency`。
- 验证：隔离 Edge 无头浏览器检查 390px 深色/浅色和 1440px 桌面布局；页面均渲染 6 个训练入口、无运行时异常，液态玻璃 `backdrop-filter` 生效。

### Apple Fitness 风格细化

- 以 Apple Fitness 的中性系统背景为基底：深色使用近黑与深灰，浅色使用系统浅灰；Activity Rings 的粉红、荧光绿、青色和系统蓝只作为图标与状态强调，移除突兀的蓝紫渐变。
- 统一圆角 token：控件 12px、分组 16px、卡片 24px、弹窗 28px、胶囊 9999px；序号改为右上角胶囊，图标固定在左上内容区，解决序号与图标重叠。
- 玻璃层改为半透明系统材质，加入 34px 高斯模糊、190% 饱和度、内高光和分层阴影；背景光晕缓慢漂移，卡片按顺序柔和入场，按压使用弹簧曲线回弹且不触发布局抖动。
- “添加动作”和“完成训练”采用同一玻璃控件结构，分别用系统蓝/绿文字与细描边表达操作语义；训练动作块、历史记录和计划项统一使用同一材质层。
- 动作管理、历史删除和版本提示去除 emoji，改用 SVG/文字语义；PingFang SC/TC 继续作为中文首选字体。
- 依据 Apple 的 Activity Rings 与 Liquid Glass 指南调整颜色与层级；使用自绘线性 SVG 图标，不复制 Apple 专有图形资产。
- 验证：390px 深色/浅色浏览器截图、训练页按钮计算样式、序号/图标无重叠、卡片 `24px` 圆角、输入栏 `12px` 圆角及 `blur(32px) saturate(1.8)` 均通过；`prefers-reduced-motion` 下关闭漂移与入场动画。

### 依赖与质量检查

- Hono 升级到 `4.13.8`，修复锁文件冲突标记；`npm ci` 和 `npm audit --audit-level=high` 均通过，报告 0 vulnerabilities。
- `test/security.test.js` 增加 Schema、用户隔离、UID、公共动作权限、依赖锁文件和前端特殊字符渲染回归检查。
- 验证完成：`npm run check`（8 项通过）、`npm ci`、`npm audit --audit-level=high`（0 vulnerabilities）、SQLite 空库初始化（10 条公用动作种子）、内联脚本语法检查、交互浏览器回归和 `git diff --check` 均通过。
