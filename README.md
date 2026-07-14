# 武技殊影图开图模拟器

剑网 3 武技殊影图开图收益模拟工具。应用会从 JX3BOX 接口更新物品价格缓存，按选择的区服、殊影图类型和开图数量随机模拟掉落结果，并计算成本、税后收益、盈亏和收益率。

> 本项目是玩家自用工具，与剑网 3、金山游戏、JX3BOX 官方无隶属关系。价格数据来自公开接口，仅供参考，实际交易价格请以游戏内和市场实时情况为准。

## 功能

- 选择区服、殊影图类型和开图数量进行模拟。
- 从 JX3BOX 更新殊影图及掉落物价格，并写入本地缓存。
- 按最低价口径估算总成本、税前总值、交易行手续费、税后收益、盈亏和 ROI。
- 支持缺失价格按 `0` 或按图成本价处理。
- 展示逐次开图明细、聚合结果和历史开图记录。
- Windows 桌面应用，基于 Tauri + React + Vite。

## 下载使用

在 GitHub Releases 下载最新的 Windows 安装包：

https://github.com/Vintcet/wuji-shadow-box-simulator/releases

推荐下载安装版：

```text
wuji-shadow-box-simulator-0.1.1-x64-setup.exe
```

如果不想安装，可以下载绿色版单文件：

```text
wuji-shadow-box-simulator-0.1.1-x64-portable.exe
```

安装后打开应用：

1. 选择区服。
2. 选择要模拟的武技殊影图。
3. 设置开图数量。
4. 点击 `更新全部价格`，等待价格缓存更新完成。
5. 选择缺失价格处理方式。
6. 点击 `开始开图` 查看模拟结果。

## 数据说明

内置掉落池数据位于：

```text
src/data/loot-pools.json
```

价格缓存保存在应用数据目录中，由应用自动维护。第一次使用或价格过期时，建议先点击 `更新全部价格`。

当前价格估算主要依赖 JX3BOX 公开接口：

- 物品搜索：`node.jx3box.com`
- 价格数据：`next2.jx3box.com`

如果接口不可用、网络异常、物品 ID 缺失或近期没有成交记录，相关物品会显示为无价格。

## 本地开发

环境要求：

- Windows
- Node.js 20+
- pnpm
- Rust stable
- Visual Studio 2022 Build Tools / MSVC
- Tauri v2 所需系统依赖

安装依赖：

```bash
pnpm install
```

启动开发环境：

```bash
pnpm dev
```

只启动前端开发服务：

```bash
pnpm dev:web
```

## 构建

生成 Windows 应用和安装包：

```bash
pnpm build
```

构建完成后，常见产物位置：

```text
src-tauri/target/release/wuji-shadow-box-simulator.exe
src-tauri/target/release/bundle/nsis/武技殊影图开图模拟器_0.1.1_x64-setup.exe
```

只构建前端：

```bash
pnpm build:web
```

## 项目结构

```text
src/renderer/        React 前端界面
src/shared/          前后端共享 TypeScript 类型
src/data/            内置掉落池数据
src-tauri/           Tauri/Rust 后端与打包配置
scripts/             数据维护和本地开发脚本
```

## 许可证

MIT License。详见 [LICENSE](LICENSE)。
