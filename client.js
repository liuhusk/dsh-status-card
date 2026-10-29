/**
 * Client 半边：内容区右上角的常驻状态卡片。
 *
 * 位置：注册在 `shell.overlay`（root / list 座位，官方指定的浮层，z-index 20）。
 *       卡片用「绝对定位 + 主内容区矩形测量」贴合 [data-conversation-content] 的右上角，
 *       并用 ResizeObserver 跟随右栏开合与窗口缩放；测量成功前用兜底位置，不做跳位动画。
 *       内容区实时宽度低于 HIDE_BELOW_CONTENT_WIDTH 时整张卡片不渲染（浮层必然吃掉右侧
 *       约 292px，再窄就盖住正文），宽度恢复后自动回来；锚点元素始终保留，
 *       否则测量链会断（offsetParent 测不到 → 宽度读回 null → 卡片复现），来回抖动。
 *
 * 内容（全部走官方只读通道）：
 *   - 任务：`todos` 投影（todo_write 写入、turn/start 重置）。
 *   - 目标：`goal` 投影（objective / phase / roundsStarted），只读——官方目标条保留操作入口。
 *   - 本次变更：本插件 Host 路由 /api/status-card.changes（整会话按路径去重 + 来源坐标）。
 *   - 本轮耗时：同一条路由带出的 `timing`（模型 / 工具 / 等你），
 *     由宿主按会话事件里的 `time` 折叠，不依赖进程内监听。
 *   - 子代理 / 队友：`sessions` 列表里 parentId 指向本会话的子会话 + `agentTeam` 投影。
 *
 * 接管：给主内容区元素加 `data-status-card-hide-todo`，用一条 CSS 隐藏官方输入框上方的
 *       「任务」面板（该面板纯展示、无任何操作）；官方目标条保留。开关见
 *       HIDE_OFFICIAL_TODO_DOCK，置 false 即恢复官方面板。
 *       卡片被空间闸门收起时**同步撤掉该标记**：替代品都不显示了，就不能再藏官方面板。
 *
 * 纯只读：不新增会话事件、不写官方状态、不改任何官方投影。卸载时样式、标记与座位注册一起回收。
 *
 * @author liuh
 */

window.__ModuleLoader__.load({
  id: '@liuhusk/dsh-status-card',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 包名：client 模块 id，也是 `plugins.bundle.config` 座位登记用的 key。 */
    const PACKAGE_NAME = '@liuhusk/dsh-status-card';
    /** 本插件自己的 locale 命名空间。 */
    const NS = 'status-card';
    /** 样式表标记，用于卸载时精确清理。 */
    const STYLE_ID = '@liuhusk/dsh-status-card/status-card.css';
    /**
     * Host 半边提供的整会话变更汇总路由。
     *
     * 故意**不带前导斜杠**：文档相对形式，与官方客户端一致（官方 `CHANGED_FILES_PATH.slice(1)`）。
     * 文档带 `<base href="./">`，根路径下 `api/x` 与 `/api/x` 等价；但一旦以「剥前缀代理」方式挂载，
     * 绝对路径会打到源站根而落空。Host 侧注册仍用绝对 `/api/...`（官方同样 host 绝对 / client 相对）。
     */
    const CHANGES_ROUTE = 'api/status-card.changes';
    /** 标记主内容区元素，用于隐藏官方任务面板。 */
    const HIDE_TODO_ATTR = 'data-status-card-hide-todo';
    /** 官方「变更审查」右栏标签的地址前缀（与 ui-deliverables 的 changesReviewAddress 同语法）。 */
    const REVIEW_PREFIX = 'dsh-resource://changes-review/session/';
    /**
     * 官方「计划」右栏标签的地址前缀（与 ui-plan 的 planAddress 同语法）。
     *
     * `kind: 'plan'` 已由官方 ui-plan 以 `builtin` 优先级注册（patterns `dsh-resource://plan/**`），
     * 这里只负责拼地址，**不要**再注册同名类型——重复注册会顶掉官方实现。
     *
     * 段数必须与官方 `parsePlanAddress` 对齐：普通会话两段 `plan/<sid>/<callId>`，
     * 子会话五段 `plan/subagent/<parent>/<child>/<mode>/<callId>`。
     * 多写一段（旧版的 `plan/session/<sid>/<callId>`）会解析失败，右栏直接抛
     * `sidebarRight: no registered tab type claims …`。
     */
    const PLAN_PREFIX = 'dsh-resource://plan/';
    /** 是否接管官方「任务」面板的展示：本插件唯一开关，置 false 即恢复官方面板。 */
    const HIDE_OFFICIAL_TODO_DOCK = true;
    /** 列表先折后展的阈值与展开后的硬上限。 */
    const ROW_LIMIT = 6;
    const ROW_HARD_CAP = 200;
    /** 卡片相对内容区右上角的间距，以及内容区测不到时的兜底位置（浮层坐标系）。 */
    const ANCHOR_GAP = 12;
    const FALLBACK_ANCHOR = { top: 78, right: 20 };
    /**
     * 降级保险丝：拿不到正文列宽度时（宿主没暴露 `--dsh-chat-content-width`，或解析失败）
     * 才回到「内容区低于此值就不渲染卡片」的老行为。卡片宽 372 + 右上间距 12 必然吃掉右侧约
     * 384px，820px 是「扣掉卡片后正文仍剩约 436px」的临界点。
     * 正常情况下走推让模型（见 CARD_WIDTH/PUSH_*），这条只是保底，避免把宿主的布局推坏。
     */
    const HIDE_BELOW_CONTENT_WIDTH = 820;

    /**
     * 推让模型的几何常量：卡片把正文「推着向左」让开自己。
     * 卡片宽度与 CSS `.sc_card{width:372px}` 是同一个数值（改宽度要两边一起改）。
     */
    const CARD_WIDTH = 372;
    /** 卡片左缘与正文右缘之间留的呼吸间距。 */
    const PUSH_TEXT_GAP = 16;
    /** 推到底时正文左缘距内容区左缘至少保留的余量。 */
    const PUSH_MIN_LEFT = 12;
    /** 收起态只给那颗圆钮让位：34px 圆钮 + 12px 锚点间距 + 8px 呼吸。 */
    const PUSH_FAB = 54;
    /** 收起与展开之间的滞回死区：已在收起态时要多出这么多余量才自动展开，避免边界抖动。 */
    const FIT_HYSTERESIS = 24;
    /** 内容区窄到连圆钮都放不下时，什么都不渲染。 */
    const MIN_CONTENT_WIDTH = 360;

    /**
     * 面板闸门：官方 layout 约定 `activePanelId === null` 表示「中央面板正在显示当前会话」，
     * 非 null 表示用户看的是别的全局面板（插件 `plugins`、定时任务 `schedules`…）。
     * 那种页面上卡片没有归属，会直接压住别人的界面。
     * 依据：dsh-client-ui-layout 的 PanelInfo.activePanelId 契约与官方自己的用法
     * （dsh-client-ui-sidebar-right：`usePanelInfo((info) => info.activePanelId === null)`）。
     */
    const selectConversationPanel = (info) => info.activePanelId === null;
    /** 宿主未提供 usePanelInfo 时的兜底：当作正在看会话（宁可显示，也不要静默消失）。 */
    const ALWAYS_CONVERSATION = () => true;

    /** 折叠态：模块级记忆，页面会话内有效，刷新页面重置。 */
    let collapsedMemory = false;

    /**
     * 主题高亮色：四档预设，`token` 是宿主静态色阶里的中调 500（明暗两种模式下同一个值）。
     * 宿主的静态色阶只有绿 / 蓝 / 靛 / 琥珀 / 红五个色相族，其中 `blue-500`(#3b82f6) 与
     * `deepseek-500`(#4176e6) 肉眼几乎同色，摆两档等于让用户挑一个看不出差别的色——
     * 所以「蓝」直接用 deepseek-500（合并前的强调色就是它，观感连贯），预设只留四档。
     * 新增一档只要在这里加一行、并在 CSS 里补一条 `[data-sc-theme=<id>]` 映射。
     */
    const THEMES = [
      { id: 'green', token: '--dsw-static-green-500', label: 'theme.green' },
      { id: 'blue', token: '--dsw-static-deepseek-500', label: 'theme.blue' },
      { id: 'amber', token: '--dsw-static-amber-500', label: 'theme.amber' },
      { id: 'red', token: '--dsw-static-red-500', label: 'theme.red' },
    ];
    /** 默认主题：绿色（改动前的卡片就是这个高亮色）。 */
    const DEFAULT_THEME = 'green';
    /**
     * 主题落盘键。放在浏览器本地：设置只在客户端消费（卡片配色），
     * 走 localStorage 可以做到「选中即生效、刷新还在」，也不用为它动 Host 配置；
     * 代价是不同浏览器 / 设备各存各的（README 的「已知偏差」里写明）。
     */
    const THEME_KEY = 'dsh-status-card:theme';

    /** 只在预设表里的 id 才算有效；其余（旧值 / 手工改坏的值）一律回落默认。 */
    function isThemeId(id) {
      return THEMES.some((theme) => theme.id === id);
    }

    /** 读落盘的主题；localStorage 缺失或被禁用时静默回落默认。 */
    function readTheme() {
      try {
        const stored = globalThis.localStorage?.getItem(THEME_KEY);
        return isThemeId(stored) ? stored : DEFAULT_THEME;
      } catch {
        return DEFAULT_THEME;
      }
    }

    /** 当前主题：卡片与插件详情页的设置块共用这一份模块级状态。 */
    let themeMemory = readTheme();
    const themeListeners = new Set();

    /** 取当前主题（组件首帧用）。 */
    function getTheme() {
      return themeMemory;
    }

    /**
     * 切换主题：写内存 → 写 localStorage（失败不影响本次生效）→ 通知订阅者。
     * @param id 预设 id，非法值直接忽略
     */
    function setTheme(id) {
      if (!isThemeId(id) || id === themeMemory) return;
      themeMemory = id;
      try {
        globalThis.localStorage?.setItem(THEME_KEY, id);
      } catch { /* 隐私模式：本次页面仍生效，只是刷新后回到默认 */ }
      for (const listener of [...themeListeners]) listener(id);
    }

    /** 订阅主题变化，返回退订函数（供 useEffect 清理）。 */
    function subscribeTheme(listener) {
      themeListeners.add(listener);
      return () => { themeListeners.delete(listener); };
    }

    /**
     * 订阅当前主题。刻意不用 `useSyncExternalStore`：测试里的 React 替身只实现了
     * useState/useRef/useEffect，多一个 hook 会让整棵卡片树渲染不出来。
     */
    function useTheme() {
      const [theme, setLocal] = React.useState(getTheme);
      React.useEffect(() => subscribeTheme(setLocal), []);
      return theme;
    }

    // 只使用 --dsw-* 主题 token，不引入任何颜色字面量。
    // 视觉目标（Codex 式紧凑卡片）：与主界面同底色（bg-base，浅色 #fff / 暗色 #151517）、
    // 仅靠 1px 淡描边分界、行式条目（左图标 · 文本 · 右数值）、
    // 11px 分组头、24px 左右的行高；数值统一 tabular-nums 便于纵向对齐。
    // 注意：不要用 bg-overlay（浅色 #e9ecf2 / 暗色 #61666b），那是遮罩灰，会和界面底色割裂。
    // 色阶只留三档（Codex 的层次就是靠这三档撑起来的）：
    //   strong = 标题与行内主文本；fg = 区块标签 / 数值 / 分组提示；weak = 状态与计数这类附属信息。
    // 上一版大量使用 --dsw-alias-label-caption(#adb2b8, 2.2:1) 与 --dsw-alias-label-dimmed(#e1e5ee, 1.2:1)，
    // 在浅色底上等于把内容画没；分隔线用的 border-l1 只有 4% 黑，也几乎看不见——这里换成 border-l2(10%)。
    const CSS = [
      '.sc_anchor{z-index:1;pointer-events:none;position:absolute}',
      // 卡片：一套局部色阶 + 强调色变量，下面所有规则只从这里取色，改版式不用摸颜色。
      // label-caption(2.2:1)/dimmed(1.2:1) 这两档在浅色底上等于把内容画没，一律不用。
      // 主题高亮色：整张卡片只有这一族高亮（on 状态的勾选环 / 进度条 / 状态点 / pill / 计划灯泡）。
      // `--sc-theme` 是主题本体（按 `data-sc-theme` 换色，见下面的映射规则），
      // `--sc-accent` 与 `--sc-accent-weak` 都从它派生：弱底色用 color-mix 现场调，
      // 这样新增一档主题只要写一行「id → token」，不用再配一份浅色底（也就不会踩到
      // 「浅色档在暗色主题下刺眼」这个坑）。
      '.sc_card{--sc-pad:16px;--sc-fg-strong:var(--dsw-alias-label-primary);--sc-fg:var(--dsw-alias-label-secondary);--sc-fg-weak:var(--dsw-alias-label-tertiary);--sc-line:var(--dsw-alias-border-l2);--sc-surface:var(--dsw-alias-bg-module-platform);--sc-theme:var(--dsw-static-green-500);--sc-accent:var(--sc-theme);--sc-accent-weak:color-mix(in srgb,var(--sc-theme) 16%,transparent);--sc-track:var(--dsw-alias-interactive-bg-active);pointer-events:auto;box-sizing:border-box;transform-origin:calc(100% - 27px) 29px;transition:opacity 170ms ease,transform 220ms cubic-bezier(.34,1.4,.64,1),visibility 0s;width:372px;max-height:calc(100vh - 120px);border:1px solid var(--sc-line);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2);color:var(--sc-fg-strong);flex-direction:column;font-size:13px;line-height:20px;display:flex;overflow:hidden}',
      // 顶栏：标题/副标题 · 两个圆形按钮；折叠后只剩那颗按钮，靠右。
      '.sc_head{align-items:flex-start;gap:10px;padding:14px 12px 10px var(--sc-pad);display:flex}',
      '.sc_headText{flex:1;min-width:0;flex-direction:column;justify-content:center;display:flex}',
      '.sc_title{font-size:14px;font-weight:600;letter-spacing:-.01em;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.sc_subtitle{color:var(--sc-fg);font-size:12px;line-height:17px;font-variant-numeric:tabular-nums;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.sc_square{flex:none;width:28px;height:28px;color:var(--sc-fg);cursor:pointer;background:var(--dsw-alias-bg-base);border:1px solid var(--sc-line);border-radius:999px;outline:none;justify-content:center;align-items:center;padding:0;font-family:inherit;display:inline-flex}',
      '.sc_square:hover{color:var(--sc-fg-strong);background:var(--dsw-alias-interactive-bg-hover)}',
      '.sc_square:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--sc-accent))}',
      // 收起：整卡缩向右上角那颗圆钮的位置并淡出，缩完才 visibility:hidden（否则残影挡住正文）。
      // 卡片与圆钮都常驻 DOM、只切锚点的 data-state——卸载就没法播收缩，也就没有伸缩感。
      '.sc_anchor[data-state="fab"] .sc_card{opacity:0;transform:scale(.16);pointer-events:none;visibility:hidden;transition:opacity 140ms ease-in,transform 190ms cubic-bezier(.4,0,.7,1),visibility 0s 190ms}',
      // 折叠形态：整张卡片收成宿主那种「回到底部」式的圆形按钮，不再留一条横条。
      '.sc_fab{position:absolute;top:12px;right:10px;pointer-events:auto;transform-origin:center;transition:opacity 170ms ease-out,transform 220ms cubic-bezier(.34,1.4,.64,1),visibility 0s;width:34px;height:34px;color:var(--dsw-alias-label-primary);cursor:pointer;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;box-shadow:var(--dsw-shadow-lv2);outline:none;justify-content:center;align-items:center;padding:0;font-family:inherit;display:inline-flex}',
      '.sc_fab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      // 展开态：圆钮缩回卡片右上角（与卡片同一原点，看着像卡片从圆钮里长出来）。
      '.sc_anchor[data-state="card"] .sc_fab{opacity:0;transform:scale(.35);pointer-events:none;visibility:hidden;transition:opacity 120ms ease-in 40ms,transform 160ms ease-in,visibility 0s 160ms}',
      // 系统关了动画就别抖：直接到位。
      '@media (prefers-reduced-motion:reduce){.sc_card,.sc_fab{transition:none}}',
      '.sc_fab:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}',
      '.sc_iconBtn{flex:none;width:24px;height:24px;color:var(--sc-fg-weak);cursor:pointer;background:0 0;border:none;border-radius:var(--dsw-radius-sm);outline:none;justify-content:center;align-items:center;padding:0;font-family:inherit;display:inline-flex}',
      '.sc_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--sc-fg-strong)}',
      '.sc_iconBtn:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--sc-accent))}',
      '.sc_icon{flex:none;width:14px;height:14px;color:currentColor;display:block}',
      '.sc_body{flex-direction:column;min-height:0;padding:0 var(--sc-pad) 12px;display:flex;overflow-y:auto}',
      // 本轮：一行文字，不再是一块浅灰圆角面（无底色 / 无圆角 / 无内边距）。
      // 左侧起点就是 body 的 --sc-pad，与下方「任务 / 变更 / 子智能体」的行首同一条竖线；
      // 总计那一段与后面的细分统计**同一档**（12px / fg / 600），只由「标签弱色 + 数值强色」分出声部，
      // 不再单独放大字号——四段读起来是一个整句，不是「主值 + 附注」。
      // 去掉面板后靠 8px 下外边距与下一个分区拉开——首段 `.sc_block:first-of-type` 没有分隔线也没有 margin。
      '.sc_bar{margin:2px 0 8px;display:flex}',
      '.sc_timing{align-items:baseline;gap:6px;min-width:0;width:100%;color:var(--sc-fg);font-size:12px;line-height:16px;display:flex;flex-wrap:wrap}',
      '.sc_timingTotal{flex:none;align-items:baseline;gap:4px;display:flex}',
      '.sc_timingLabel{flex:none;color:var(--sc-fg-weak)}',
      '.sc_timingTotalValue{flex:none;color:var(--sc-fg);font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
      '.sc_timingItem{align-items:baseline;gap:4px;min-width:0;display:flex}',
      '.sc_timingName{flex:none;color:var(--sc-fg-weak)}',
      '.sc_timingValue{color:var(--sc-fg);font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
      '.sc_timingDot{flex:none;color:var(--sc-fg-weak)}',
      '.sc_pill{flex:none;margin-left:auto;max-width:100%;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--sc-fg-strong);font-size:12px;line-height:20px;font-weight:500;font-variant-numeric:tabular-nums;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.sc_pill[data-tone=ok]{color:var(--sc-accent);background:var(--sc-accent-weak)}',
      '.sc_pill[data-tone=accent]{color:var(--sc-accent);background:var(--sc-accent-weak)}',
      '.sc_pill[data-tone=error]{color:var(--dsw-alias-state-error-primary);background:var(--sc-surface)}',
      '.sc_pill[data-tone=muted]{color:var(--sc-fg);background:var(--dsw-alias-interactive-bg-active)}',
      '.sc_space{display:none}',
      // 区块：1px 分隔线 + 12px 间距；首段不画线，避免顶栏下方多出一道横线。
      '.sc_block{border-top:1px solid var(--sc-line);margin-top:12px;padding-top:10px}',
      '.sc_block:first-of-type{border-top:none;margin-top:0;padding-top:4px}',
      // 分区头：图标落 16px 列 · 加粗标题 · 可选计数 pill · 右对齐的动作与数值。
      '.sc_blockHead{align-items:center;gap:8px;min-height:24px;margin:0 -6px;padding:0 6px;display:flex}',
      '.sc_blockTitle{color:var(--sc-fg-strong);font-size:15px;font-weight:600;letter-spacing:.01em;line-height:22px}',
      '.sc_countPill{flex:none;padding:0 7px;border-radius:999px;background:var(--sc-surface);color:var(--sc-fg);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums}',
      '.sc_secTail{margin-left:auto;align-items:center;gap:6px;display:flex}',
      '.sc_blockMeta{color:var(--sc-fg-weak);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.sc_rows{flex-direction:column;margin:2px 0 0;padding:0;list-style:none;display:flex}',
      '.sc_row{display:block;min-width:0}',
      // 行：三列网格（16px 图标列 · 弹性文本 · 右对齐数值），整行胶囊左右各溢出 6px 对齐内边距。
      '.sc_rowInner,.sc_rowBtn{box-sizing:border-box;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;column-gap:8px;display:grid;width:calc(100% + 12px);min-height:28px;margin:0 -6px;padding:0 6px;border-radius:var(--dsw-radius-sm);color:var(--sc-fg-strong);font-family:inherit;font-size:13px;text-align:left}',
      '.sc_rowBtn{cursor:pointer;background:0 0;border:none}',
      '.sc_rowBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sc_rowBtn:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--sc-accent))}',
      '.sc_rowLead{flex:none;width:16px;height:16px;color:var(--sc-fg-weak);justify-content:center;align-items:center;display:flex}',
      '.sc_fileIcon{flex:none;width:16px;height:16px;color:var(--dsw-static-neutral-bluish-300)}',
      '.sc_fileIcon[data-kind=code],.sc_fileIcon[data-kind=html],.sc_fileIcon[data-kind=markdown]{color:var(--dsw-static-deepseek-500)}',
      '.sc_fileIcon[data-kind=javascript]{color:var(--dsw-static-amber-500)}',
      '.sc_fileIcon[data-kind=typescript]{color:var(--dsw-static-blue-500)}',
      '.sc_fileIcon[data-kind=json]{color:var(--dsw-static-amber-400)}',
      '.sc_fileIcon[data-kind=python]{color:var(--dsw-static-green-500)}',
      '.sc_fileIcon[data-kind=rust]{color:var(--dsw-static-amber-600)}',
      '.sc_fileIcon[data-kind=go]{color:var(--dsw-static-blue-400)}',
      '.sc_fileIcon[data-kind=java]{color:var(--dsw-static-red-500)}',
      '.sc_fileIcon[data-kind=clang]{color:var(--dsw-static-blue-600)}',
      '.sc_fileIcon[data-kind=shell]{color:var(--dsw-static-neutral-bluish-500)}',
      '.sc_fileIcon[data-kind=stylesheet]{color:var(--dsw-static-blue-450)}',
      '.sc_fileIcon[data-kind=config]{color:var(--dsw-static-neutral-bluish-600)}',
      '.sc_fileIcon[data-kind=sql]{color:var(--dsw-static-deepseek-450)}',
      '.sc_fileIcon[data-kind=excel]{color:var(--dsw-static-green-500)}',
      '.sc_fileIcon[data-kind=image],.sc_fileIcon[data-kind=video]{color:var(--dsw-static-blue-400)}',
      '.sc_fileIcon[data-kind=pdf]{color:var(--dsw-static-red-600)}',
      '.sc_fileIcon[data-kind=ppt]{color:var(--dsw-static-amber-500)}',
      '.sc_fileIcon[data-kind=word]{color:var(--dsw-static-deepseek-450)}',
      // 状态圆点：静态三档是 6px 实心点；running 换成「转圈」——6px 占位不动、用绝对定位的
      // ::after 画 10px 圆环盖在点位上（inset:-2px），行内列宽不变，文字不会因为状态切换跳 4px。
      // 转圈参数照官方 spinner（ui-attachment / settings-account）的写法：1.5px 边框、顶边亮一档当缺口、
      // .8s linear infinite；关掉动画偏好时停在圆环上仍读得出「进行中」。
      '.sc_mark{position:relative;flex:none;width:6px;height:6px;border-radius:50%;background:var(--sc-fg-weak)}',
      '.sc_mark[data-state=running]{background:0 0}',
      '.sc_mark[data-state=running]::after{content:"";box-sizing:border-box;border:1.5px solid var(--dsw-alias-border-l4);border-top-color:var(--sc-accent);border-radius:50%;animation:sc_spin .8s linear infinite;position:absolute;inset:-2px}',
      // 转圈只有一份 keyframes：成员卡圆点与任务行勾选圆共用同一节奏。
      '@keyframes sc_spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.sc_mark[data-state=running]::after,.sc_check[data-state=running]{animation:none}}',
      '.sc_mark[data-state=done]{background:var(--sc-accent)}',
      '.sc_mark[data-state=warn]{background:var(--dsw-alias-state-warn-primary)}',
      '.sc_mark[data-state=error]{background:var(--dsw-alias-state-error-primary)}',
      '.sc_text{min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.sc_meta{margin-left:auto;color:var(--sc-fg-weak);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;grid-auto-flow:column;justify-content:end;column-gap:10px;display:grid}',
      '.sc_num{color:inherit;font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;text-align:right}',
      // 增删数字取 marker 前景色：--dsw-alias-code-diff-added/deleted 是 8%~12% 透明的底色，
      // 当文字色用等于把数字画成透明（上一版「没有高亮」的真凶）。
      '.sc_add{color:var(--dsw-alias-file-diff-added-marker);min-width:46px;text-align:right}',
      '.sc_del{color:var(--dsw-alias-file-diff-deleted-marker);min-width:46px;text-align:right}',
      // 合计：比行内数值大一档 + 加粗，是整张卡片最醒目的数字。
      '.sc_total{margin-left:12px;font-variant-numeric:tabular-nums;grid-auto-flow:column;justify-content:end;column-gap:10px;display:grid}',
      '.sc_total .sc_num{font-size:13px;font-weight:600;min-width:52px}',
      // 任务进度条：绿色实心填充，轨道用交互底色（浅/暗主题都不刺眼）。
      '.sc_progress{height:2px;margin:8px 0 0;border-radius:999px;background:var(--sc-track);overflow:hidden}',
      '.sc_progressFill{height:100%;border-radius:inherit;background:var(--sc-accent)}',
      // 勾选圆三态：done=空心绿环 + 绿勾 · running=整颗环自转 · idle=灰空环。
      // 勾号给 14px 而不是 10px：`check` 的 path 只占 16 viewBox 中间约 58%（M3.4 8.2l3 3 6.2-6.4），
      // 10px 时墨迹只有 ~5.8px，空心环里几乎看不见；14px 墨迹约 8px，正好落在环心。
      '.sc_check{flex:none;box-sizing:border-box;width:16px;height:16px;border:1.4px solid var(--dsw-alias-border-l4);border-radius:50%;justify-content:center;align-items:center;display:flex}',
      '.sc_check .sc_icon{width:14px;height:14px}',
      '.sc_check[data-state=done]{border-color:var(--sc-accent);color:var(--sc-accent)}',
      // 进行中（任务行 `in_progress`）：整颗 16px 环自己转——轨道沿用 idle 那圈灰（border-l4），
      // 只把顶边点亮成实绿，转起来就是「还在跑」。原来是「绿环 + 中心绿点」，看不出动静。
      '.sc_check[data-state=running]{border-top-color:var(--sc-accent);animation:sc_spin .8s linear infinite}',
      // 计划：整行卡（与「权限」条同一块灰面）+ 行首无图标 + 右侧外链图标，点开官方 plan 预览。
      '.sc_planRow{align-items:center;gap:6px;box-sizing:border-box;width:calc(100% + 12px);margin:1px -6px 0;padding:4px 6px;color:var(--sc-fg-strong);background:0 0;border:none;border-radius:var(--dsw-radius-sm);cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;text-align:left;display:flex}',
      '.sc_planRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sc_planRow:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--sc-accent))}',
      '.sc_planLabel{flex:1;min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.sc_planOpen{flex:none;color:var(--sc-fg-weak);display:flex}',
      '.sc_planIcon{flex:none;color:var(--sc-accent);display:flex;filter:drop-shadow(0 0 3px var(--sc-accent)) drop-shadow(0 0 7px var(--sc-accent))}',
      // 目标正文：浅灰圆角块（参考图里目标是一整块浅灰面，不是裸文本）。
      '.sc_goal{color:var(--sc-fg-strong);-webkit-line-clamp:3;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden;font-size:13px;line-height:19px;margin:8px 0 0;padding:0;background:0 0}',
      '.sc_note{color:var(--sc-fg);font-size:12px;line-height:18px;margin:4px 0 0;padding-left:24px}',
      '.sc_noteError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:4px 0 0;padding-left:24px}',
      // 变更块的轮次分组头：11px 加间距，颜色用 fg（不是 caption），保证「本轮 / 更早」看得清。
      '.sc_group{margin:10px -6px 0;padding:0 6px;color:var(--sc-fg);font-size:11px;font-weight:500;letter-spacing:.04em;line-height:20px}',
      '.sc_more{align-self:flex-start;margin:2px -6px 0;color:var(--sc-fg);cursor:pointer;background:0 0;border:none;text-align:left;padding:0 6px;font-family:inherit;font-size:12px;line-height:24px;border-radius:var(--dsw-radius-sm)}',
      '.sc_more:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--sc-fg-strong)}',
      '.sc_more:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--sc-accent))}',
      '.sc_blockHead .sc_iconBtn{width:22px;height:22px;margin-right:-6px}',
      '.sc_blockHead .sc_iconBtn:disabled{opacity:.45;cursor:default}',
      '.sc_blockHead .sc_iconBtn:disabled:hover{background:0 0;color:var(--sc-fg-weak)}',
      // 成员卡：状态圆点 + 两行文本 + 指标（token · 耗时）+ 展开箭头，与官方子智能体目录行同构。
      '.sc_member{box-sizing:border-box;grid-template-columns:auto minmax(0,1fr) auto 12px;align-items:center;column-gap:8px;width:calc(100% + 12px);margin:0 -6px 2px;padding:6px;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--sc-fg-strong);display:grid}',
      '.sc_member:last-child{margin-bottom:0}',
      '.sc_memberBtn{appearance:none;border:none;font:inherit;text-align:left;cursor:pointer;background:0 0;color:var(--sc-fg-strong)}',
      '.sc_memberBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sc_memberBtn:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--sc-accent))}',
      '.sc_memberMain{min-width:0;flex-direction:column;display:flex}',
      '.sc_memberName{font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.sc_memberDesc{color:var(--sc-fg);font-size:12px;line-height:17px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.sc_memberTail{align-items:flex-end;flex-direction:column;gap:1px;justify-self:end;display:flex;font-variant-numeric:tabular-nums}',
      '.sc_metrics{color:var(--sc-fg);font-size:12px;line-height:16px;white-space:nowrap}',
      '.sc_metricsSub{color:var(--sc-fg-weak);font-size:11px;line-height:15px;white-space:nowrap}',
      '.sc_memberChevron{flex:none;color:var(--sc-fg-weak);justify-content:flex-end;display:flex}',
      '.sc_goalEdit{box-sizing:border-box;width:100%;min-height:64px;resize:vertical;border:1px solid var(--sc-line);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--sc-fg-strong);font-family:inherit;font-size:13px;line-height:19px;margin:4px 0 2px;padding:8px 10px;outline:none}',
      '.sc_goalEdit:focus{border-color:var(--sc-accent);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--sc-accent))}',
      '.sc_goalActions{justify-content:flex-end;gap:6px;margin-top:4px;display:flex}',
      '.sc_action{color:var(--sc-accent);cursor:pointer;background:0 0;border:none;border-radius:var(--dsw-radius-sm);font-family:inherit;font-size:12px;line-height:22px;padding:0 8px}',
      '.sc_action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sc_action:disabled{opacity:.45;cursor:default}',
      '.sc_action:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--sc-accent))}',
      // 接管官方「任务」面板：只对主内容区元素生效（右栏子代理会话里的同一面板不受影响）。
      '[data-conversation-content][data-status-card-hide-todo] [data-testid="todo-panel"]{display:none!important}',
      // 推让是给宿主元素写 padding-right（见 useCardLayout），给个短过渡免得收放时正文瞬移。
      '[data-conversation-content]{transition:padding-right 140ms ease}',
      '@media (prefers-reduced-motion:reduce){[data-conversation-content]{transition:none}}',
      // 主题预设：id → 宿主静态色阶里的中调 500（明暗模式同一个值，暗色下也不发灰）。
      // 四档色相互相都分得开（见 THEMES 的注释：blue 与 deepseek 同族，只留一个）。
      // 选择器带两个类级片段（0,2,0），高于 `.sc_card`（0,1,0）里那条默认 `--sc-theme`，
      // 所以规则在数组里的先后不影响结果，也不会被卡片的局部色阶吃掉。
      '.sc_card[data-sc-theme=green],.sc_themeChip[data-sc-theme=green]{--sc-theme:var(--dsw-static-green-500)}',
      '.sc_card[data-sc-theme=blue],.sc_themeChip[data-sc-theme=blue]{--sc-theme:var(--dsw-static-deepseek-500)}',
      '.sc_card[data-sc-theme=amber],.sc_themeChip[data-sc-theme=amber]{--sc-theme:var(--dsw-static-amber-500)}',
      '.sc_card[data-sc-theme=red],.sc_themeChip[data-sc-theme=red]{--sc-theme:var(--dsw-static-red-500)}',
      // 插件详情页里的「高亮色」设置块（座位 plugins.bundle.config）。它渲染在卡片之外，
      // 所以颜色一律取宿主别名 token，只有色点本身用预设带下来的 `--sc-theme`。
      '.sc_theme{flex-direction:column;gap:8px;display:flex}',
      '.sc_themeHead{align-items:baseline;gap:8px;flex-wrap:wrap;display:flex}',
      '.sc_themeTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px}',
      '.sc_themeHint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.sc_themeRow{gap:8px;flex-wrap:wrap;display:flex}',
      '.sc_themeChip{align-items:center;gap:6px;cursor:pointer;padding:4px 10px 4px 8px;font-family:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;display:inline-flex}',
      '.sc_themeChip:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.sc_themeChip:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--sc-theme))}',
      '.sc_themeChip[aria-pressed=true]{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--sc-theme) 12%,transparent);border-color:var(--sc-theme)}',
      '.sc_themeDot{flex:none;width:12px;height:12px;border-radius:999px;background:var(--sc-theme)}',
      // 选中态的色点外再套一圈卡底色 + 一圈主题色：不是只靠底色深浅辨认。
      '.sc_themeChip[aria-pressed=true] .sc_themeDot{box-shadow:0 0 0 2px var(--dsw-alias-bg-base),0 0 0 3px var(--sc-theme)}',
      // 后台任务：行结构、分组头与「停止」按钮都照宿主「后台任务」面板的度量来
      // （圆点 + 类型标签 + 等宽命令 + 状态/进度 + 时长，行首 20×20 见方的小按钮）。
      '.sc_jobLine{align-items:center;gap:6px;display:flex}',
      // 运行中的行铺一层淡底：官方面板靠这层 fill 把「还在跑」的行从已结束的行里拎出来。
      '.sc_jobLine[data-live=true]{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);padding:4px 8px 4px 2px}',
      '.sc_jobRow{box-sizing:border-box;min-width:0;flex:1;align-items:center;gap:6px;padding:4px 7px;font-size:12px;line-height:17px;display:flex}',
      '.sc_jobRow[data-settled=true]{color:var(--sc-fg-weak);min-height:28px}',
      '.sc_jobMain{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}',
      '.sc_jobPrimary{align-items:baseline;gap:8px;min-width:0;display:flex}',
      '.sc_jobSecondary{align-items:center;gap:6px;min-width:0;display:flex}',
      '.sc_jobKind{border-radius:var(--dsw-radius-xs);background:var(--sc-surface);color:var(--sc-fg);flex:none;padding:0 5px;font-size:10px;line-height:16px}',
      '.sc_jobLabel{min-width:0;font-family:var(--dsw-font-mono);white-space:nowrap;text-overflow:ellipsis;flex:1;overflow:hidden}',
      // 卡片比宿主那个 500px 的浮层窄得多：状态/结算原因让到 40%，把宽度留给命令本身。
      '.sc_jobStatus{max-width:40%;color:var(--sc-fg-weak);white-space:nowrap;text-overflow:ellipsis;flex:none;font-size:10px;line-height:16px;overflow:hidden}',
      '.sc_jobDuration{color:var(--sc-fg-weak);font-variant-numeric:tabular-nums;flex:none;font-size:11px;line-height:18px}',
      // 「停止」：官方面板是一颗 20×20 的方形描边按钮（内含实心方块）；第一次点击只上膛，
      // 展开成「确认停止」的胶囊，再点才真的发 kill。
      '.sc_stop{box-sizing:border-box;flex:none;border:.5px solid var(--sc-line);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);width:20px;height:20px;color:var(--sc-fg);cursor:pointer;font-family:inherit;justify-content:center;align-self:center;align-items:center;gap:4px;padding:0;display:inline-flex}',
      '.sc_stop:hover,.sc_stop:focus-visible,.sc_stop[data-kill-state=armed],.sc_stop[data-kill-state=failed]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.sc_stop:hover,.sc_stop:focus-visible{outline:none}',
      '.sc_stop[data-kill-state=armed]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);width:auto;padding:0 7px}',
      '.sc_stop[data-kill-state=pending]{cursor:default;opacity:.6}',
      '.sc_stopLabel{white-space:nowrap;font-size:11px;line-height:18px}',
      // 「已结束 N」分组头：上边一条分隔线、左边折叠开关、右边「清空」——与官方面板同构。
      '.sc_jobSection{border-top:.5px solid var(--sc-line);color:var(--sc-fg-weak);justify-content:space-between;align-items:center;margin:4px 0 1px;padding:4px 0 3px;font-size:11px;line-height:16px;display:flex}',
      '.sc_jobToggle,.sc_jobClear{border-radius:var(--dsw-radius-sm);color:var(--sc-fg-weak);cursor:pointer;background:0 0;border:0;align-items:center;gap:3px;padding:2px 4px;font-size:11px;line-height:16px;font-family:inherit;display:inline-flex}',
      '.sc_jobToggle:hover,.sc_jobToggle:focus-visible,.sc_jobClear:hover,.sc_jobClear:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--sc-fg-strong);outline:none}',
      // 折叠箭头：闭上指右（-90°），展开时转正——与官方面板的分组箭头同一个动画。
      '.sc_jobChevron{transition:transform .12s;transform:rotate(-90deg)}',
      '.sc_jobChevron[data-open=true]{transform:none}',
    ].join('');

    /** 简体中文（键集基准）。 */
    const zh = {
      'card.title': '状态',
      'card.collapse': '收起卡片',
      'card.expand': '展开卡片',
      'card.refresh': '刷新变更数据',
      'card.subtitle': 'Agent 工作区',
      'card.empty': '暂无任务与变更',
      'theme.title': '高亮色',
      'theme.hint': '卡片里的高亮色（图标、进度条、勾选环与计数标记）。默认绿色；错误与警告色、文件类型图标的颜色保持原义。',
      'theme.green': '绿',
      'theme.blue': '蓝',
      'theme.amber': '琥珀',
      'theme.red': '红',
      'theme.selected': '当前主题',
      'task.title': '任务',
      'task.progress': '{done}/{total} 已完成',
      'task.more': '查看全部 {total} 项',
      'task.less': '收起',
      'list.expand': '展开',
      'list.collapse': '收起',
      'goal.title': '目标',
      'goal.phase.active': '进行中',
      'goal.phase.paused': '已暂停',
      'goal.phase.blocked': '受阻',
      'goal.phase.complete': '已完成',
      'goal.round': '第 {round} 轮',
      'goal.blockedReason': '原因：{reason}',
      'goal.edit': '编辑目标',
      'goal.pause': '暂停目标',
      'goal.resume': '继续目标',
      'goal.clear': '清除目标',
      'goal.save': '保存',
      'goal.cancel': '取消',
      'goal.placeholder': '目标内容',
      'goal.error': '操作失败：{detail}',
      'goal.unavailable': '目标服务不可用',
      'plan.title': '计划',
      'plan.meta': '{total} 个计划',
      'plan.active': '计划中',
      'plan.untitled': '未命名计划',
      'plan.open': '在侧边栏预览计划：{title}',
      'plan.more': '查看全部 {total} 个计划',
      'changes.title': '变更',
      'changes.meta': '{total} 个文件',
      'changes.loading': '读取变更…',
      'changes.unavailable': '变更数据不可用',
      'changes.more': '查看全部 {total} 个文件',
      'changes.less': '收起',
      'changes.open': '打开 {path} 的变更审查',
      'changes.currentTurn': '本轮 · {total} 个文件',
      'changes.earlier': '更早改动 · {total} 个文件',
      'list.overflow': '还有 {rest} 项未显示',
      'agents.title': '子智能体',
      'agents.team': '队友 {members} · 任务 {done}/{total}',
      'agents.teammate': '队友',
      'agents.subagent': '子智能体',
      'agents.activity.running': '正在运行',
      'agents.activity.completed': '已完成',
      'agents.activity.inactive': '当前未运行',
      'agents.phase.failed': '失败',
      'agents.phase.provisioning': '准备中',
      'agents.mode.oneShot': '一次性',
      'agents.mode.continuable': '可继续',
      'agents.mode.external': '外部任务',
      'agents.mode.unknown': '模式未知',
      'agents.tokens.k': '{value}K',
      'agents.tokens.m': '{value}M',
      'agents.metrics.tokens': '{value} tok',
      'agents.duration.seconds': '{seconds}秒',
      'agents.duration.minutes': '{minutes}分{seconds}秒',
      'agents.duration.hours': '{hours}小时{minutes}分{seconds}秒',
      'agents.duration.days': '{days}天{hours}小时',
      'agents.round.current': '本轮',
      'agents.round.n': '第 {round} 轮',
      'agents.round.meta': '{label} · {count} 个',
      'agents.earlier': '早前 {rounds} 轮 · {count} 个',
      'jobs.title': '后台任务',
      'jobs.badge': '{count} 个后台任务运行中',
      'jobs.settled': '已结束 {count}',
      'jobs.clear': '清空',
      // 状态词与时长文案跟宿主「后台任务」面板逐字一致：两处指向同一件事，措辞不该分叉。
      'jobs.status.running': '运行中',
      'jobs.status.stopping': '正在停止',
      'jobs.status.completed': '已完成',
      'jobs.status.killed': '已取消',
      'jobs.status.failed': '已失败',
      'jobs.duration.seconds': '{seconds}秒',
      'jobs.duration.minutes': '{minutes}分{seconds}秒',
      'jobs.duration.hours': '{hours}小时{minutes}分',
      'jobs.duration.live': '已运行 {duration}',
      'jobs.duration.done': '耗时 {duration}',
      'jobs.stopTitle': '停止任务 {label}',
      'jobs.stopConfirm': '再次点击确认停止',
      'jobs.stopAction': '确认停止',
      'jobs.stopFailed': '停止失败',
      'timing.total': '本轮',
      'timing.model': '模型',
      'timing.tool': '工具',
      'timing.wait': '等你',
    };

    /** English（与中文键集逐字对齐）。 */
    const en = {
      'card.title': 'Status',
      'card.collapse': 'Collapse card',
      'card.expand': 'Expand card',
      'card.refresh': 'Refresh changes',
      'card.subtitle': 'Agent workspace',
      'card.empty': 'No tasks or changes yet',
      'theme.title': 'Accent color',
      'theme.hint': 'The card\'s highlight color (icons, progress bar, check rings and count badges). Green is the default; error, warning and file-type colors keep their meaning.',
      'theme.green': 'Green',
      'theme.blue': 'Blue',
      'theme.amber': 'Amber',
      'theme.red': 'Red',
      'theme.selected': 'Current accent',
      'task.title': 'To-dos',
      'task.progress': '{done}/{total} completed',
      'task.more': 'Show all {total}',
      'task.less': 'Collapse',
      'list.expand': 'Expand',
      'list.collapse': 'Collapse',
      'goal.title': 'Goal',
      'goal.phase.active': 'Ongoing',
      'goal.phase.paused': 'Paused',
      'goal.phase.blocked': 'Blocked',
      'goal.phase.complete': 'Complete',
      'goal.round': 'Round {round}',
      'goal.blockedReason': 'Reason: {reason}',
      'goal.edit': 'Edit goal',
      'goal.pause': 'Pause goal',
      'goal.resume': 'Resume goal',
      'goal.clear': 'Clear goal',
      'goal.save': 'Save',
      'goal.cancel': 'Cancel',
      'goal.placeholder': 'Goal objective',
      'goal.error': 'Action failed: {detail}',
      'goal.unavailable': 'Goal service unavailable',
      'plan.title': 'Plans',
      'plan.meta': '{total} plans',
      'plan.active': 'Planning',
      'plan.untitled': 'Untitled plan',
      'plan.open': 'Preview the plan in the sidebar: {title}',
      'plan.more': 'Show all {total} plans',
      'changes.title': 'Changes',
      'changes.meta': '{total} files',
      'changes.loading': 'Reading changes…',
      'changes.unavailable': 'Change data unavailable',
      'changes.more': 'Show all {total} files',
      'changes.less': 'Collapse',
      'changes.open': 'Open the change review for {path}',
      'changes.currentTurn': 'This turn · {total} files',
      'changes.earlier': 'Earlier turns · {total} files',
      'list.overflow': '{rest} more not shown',
      'agents.title': 'Subagents',
      'agents.team': 'Teammates {members} · tasks {done}/{total}',
      'agents.teammate': 'Teammate',
      'agents.subagent': 'Subagent',
      'agents.activity.running': 'Running',
      'agents.activity.completed': 'Completed',
      'agents.activity.inactive': 'Not running',
      'agents.phase.failed': 'Failed',
      'agents.phase.provisioning': 'Starting',
      'agents.mode.oneShot': 'One-shot',
      'agents.mode.continuable': 'Continuable',
      'agents.mode.external': 'External',
      'agents.mode.unknown': 'Unknown mode',
      'agents.tokens.k': '{value}K',
      'agents.tokens.m': '{value}M',
      'agents.metrics.tokens': '{value} tok',
      'agents.duration.seconds': '{seconds}s',
      'agents.duration.minutes': '{minutes}m {seconds}s',
      'agents.duration.hours': '{hours}h {minutes}m {seconds}s',
      'agents.duration.days': '{days}d {hours}h',
      'agents.round.current': 'This turn',
      'agents.round.n': 'Turn {round}',
      'agents.round.meta': '{label} · {count}',
      'agents.earlier': 'Earlier turns ({rounds}) · {count}',
      'jobs.title': 'Background jobs',
      'jobs.badge': '{count} background jobs running',
      'jobs.settled': '{count} finished',
      'jobs.clear': 'Clear',
      'jobs.status.running': 'running',
      'jobs.status.stopping': 'stopping',
      'jobs.status.completed': 'completed',
      'jobs.status.killed': 'cancelled',
      'jobs.status.failed': 'failed',
      'jobs.duration.seconds': '{seconds}s',
      'jobs.duration.minutes': '{minutes}m {seconds}s',
      'jobs.duration.hours': '{hours}h {minutes}m',
      'jobs.duration.live': 'Running for {duration}',
      'jobs.duration.done': 'Took {duration}',
      'jobs.stopTitle': 'Stop task {label}',
      'jobs.stopConfirm': 'Click again to confirm',
      'jobs.stopAction': 'Confirm stop',
      'jobs.stopFailed': 'Stop failed',
      'timing.total': 'Turn',
      'timing.model': 'Model',
      'timing.tool': 'Tools',
      'timing.wait': 'Waiting',
    };

    /** 空数组常量：让选择器在无数据时也返回稳定引用。 */
    const NO_ROWS = [];

    /** 注入本插件样式，卸载时移除该 style 元素。 */
    function injectStyles() {
      if (typeof document === 'undefined') return () => {};
      const tag = document.createElement('style');
      tag.setAttribute('data-plugin-css', STYLE_ID);
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.isConnected) tag.remove();
      };
    }

    // #region 纯函数（可直接单测）

    /** 千分位分组，避免依赖运行环境的 locale。 */
    function groupDigits(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
      return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** 从 cwd 取项目名，作为卡片标题。 */
    function basename(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return undefined;
      const parts = cwd.split(/[\\/]+/u).filter((part) => part !== '');
      return parts.length === 0 ? undefined : parts[parts.length - 1];
    }

    /** `todos` 投影（TodoItem[] | null）→ 行表。 */
    function taskRows(todos) {
      return Array.isArray(todos) ? todos : NO_ROWS;
    }

    /** 任务进度：done / total。 */
    function taskProgress(rows) {
      let done = 0;
      for (const row of rows) if (row?.status === 'completed') done += 1;
      return { done, total: rows.length };
    }

    /** 任务状态 → 圆点语义。 */
    function taskMark(status) {
      if (status === 'completed') return 'done';
      if (status === 'in_progress') return 'running';
      return 'idle';
    }

    /** `goal` 投影 → 阶段词典键。 */
    function goalPhaseKey(goal) {
      const phase = goal?.goal?.phase;
      return phase === 'paused' || phase === 'blocked' || phase === 'complete'
        ? `goal.phase.${phase}`
        : 'goal.phase.active';
    }

    /** 目标 phase → pill 色调（active 用强调色、完成用绿、受阻用红，其余中性）。 */
    function goalPhaseTone(phase) {
      if (phase === 'complete') return 'ok';
      if (phase === 'blocked') return 'error';
      if (phase === 'active') return 'accent';
      return 'muted';
    }

    /** 本会话的子会话（子代理）行表：顺序稳定，便于选择器等值比较。 */
    function subagentRows(snapshot, sessionId, statuses) {
      if (snapshot === undefined || sessionId === undefined) return NO_ROWS;
      const rows = [];
      for (const row of Object.values(snapshot.byId)) {
        if (row === undefined || row === null || row.parentId !== sessionId) continue;
        const identity = row.projectionValues?.subagent;
        const timing = row.projectionValues?.subagentTiming;
        const label = typeof identity?.label === 'string' && identity.label !== '' ? identity.label : null;
        const durableTitle = typeof row.title === 'string' && row.title !== '' ? row.title : null;
        const displayTitle = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : null;
        const running = statuses?.get(row.id)?.running === true || row.running === true;
        rows.push({
          key: String(row.id),
          // 主行与官方一致：优先 spawn 时给的 label，再退会话标题。
          name: label ?? durableTitle ?? displayTitle ?? String(row.id),
          // 副行第一段是会话标题（通常是「任务：…」）；与主行相同就当没有。
          title: durableTitle !== null && durableTitle !== (label ?? durableTitle) ? durableTitle : null,
          mode: typeof identity?.mode === 'string' ? identity.mode : null,
          running,
          completed: !running && timing?.lastTurnCompleted === true,
          tokens: tokenTotal(row.projectionValues?.tokenUsage),
          settledMs: typeof timing?.settledMs === 'number' ? timing.settledMs : 0,
          activeSince: typeof timing?.active?.since === 'number' ? timing.active.since : null,
          activeThrough: typeof timing?.active?.through === 'number' ? timing.active.through : null,
        });
      }
      if (rows.length === 0) return NO_ROWS;
      rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : left.key < right.key ? -1 : 1));
      return rows;
    }

    /** 子智能体行表的浅比较：行数与每行参与展示的字段（含 token / 耗时窗口）。 */
    function equalRows(left, right) {
      if (left === right) return true;
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        const a = left[index];
        const b = right[index];
        if (a.key !== b.key
          || a.name !== b.name
          || a.title !== b.title
          || a.mode !== b.mode
          || a.running !== b.running
          || a.completed !== b.completed
          || a.tokens !== b.tokens
          || a.settledMs !== b.settledMs
          || a.activeSince !== b.activeSince
          || a.activeThrough !== b.activeThrough) return false;
      }
      return true;
    }

    /**
     * 子智能体行按「派生它的轮次」分组。
     *
     * 卡片列的是整会话的子会话目录，多轮委派会越攒越多；默认只摊开当前轮次，早前的轮次折起来。
     * 轮次来源是宿主路由的 `subagentTurns`（子会话 id → 轮次号）；拿不到归属的行（路由还没扫到、
     * 或宿主是老版本）一律并进当前轮，不额外造一组。
     *
     * @param rows 子智能体行表（`subagentRows` 的结果）
     * @param turns 宿主给的 `{ [childId]: turn }`
     * @param currentTurn 当前轮次号（宿主 `timing.turn`）
     * @returns `{ current, rounds, total }`；`rounds` 是早前轮次，按轮次倒序（新的在前）
     */
    function agentGroups(rows, turns, currentTurn) {
      if (rows.length === 0) return { current: NO_ROWS, rounds: NO_ROWS, total: 0 };
      const current = [];
      const earlier = new Map();
      for (const row of rows) {
        const turn = turns !== null && turns !== undefined ? turns[row.key] : undefined;
        if (typeof turn !== 'number' || turn === currentTurn) {
          current.push(row);
          continue;
        }
        const bucket = earlier.get(turn);
        if (bucket === undefined) earlier.set(turn, [row]);
        else bucket.push(row);
      }
      const rounds = [...earlier.entries()]
        .sort((left, right) => right[0] - left[0])
        .map(([turn, list]) => ({ turn, rows: list }));
      return { current, rounds, total: rows.length };
    }

    /** `agentTeam` 投影 → { teammates, done, total, failure }；无内容时为 null。 */
    function teamSummary(team) {
      if (team === null || team === undefined) return null;
      const members = Array.isArray(team.members) ? team.members : NO_ROWS;
      const tasks = Array.isArray(team.tasks) ? team.tasks : NO_ROWS;
      let done = 0;
      for (const task of tasks) if (task?.status === 'completed') done += 1;
      const summary = {
        teammates: members.filter((member) => member?.role !== 'lead'),
        done,
        total: tasks.length,
        failure: typeof team.failure === 'string' && team.failure !== '' ? team.failure : null,
      };
      const empty = summary.teammates.length === 0 && summary.total === 0 && summary.failure === null;
      return empty ? null : summary;
    }

    /** 队友阶段 → 圆点语义。 */
    function phaseMark(phase) {
      if (phase === 'failed') return 'error';
      if (phase === 'active') return 'running';
      if (phase === 'provisioning') return 'warn';
      return 'idle';
    }

    /** 官方「变更审查」右栏标签地址（与 ui-deliverables 的 changesReviewAddress 同语法）。 */
    function reviewAddress(sessionId, seq, turn) {
      return `${REVIEW_PREFIX}${encodeURIComponent(sessionId)}/${seq}/${turn}`;
    }

    /**
     * 官方「计划」预览地址（与 ui-plan 的 planAddress 同语法）。
     *
     * @param sessionId 屏上主会话
     * @param callId `exit_plan_mode` 的工具调用 id
     * @param child `sessions.subagentAddress(sessionId)` 的结果；给了就拼子会话五段地址
     */
    function planAddress(sessionId, callId, child) {
      if (child === undefined || child === null) {
        return `${PLAN_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(callId)}`;
      }
      return [
        'subagent',
        encodeURIComponent(String(child.parentSessionId)),
        encodeURIComponent(String(child.childSessionId)),
        encodeURIComponent(String(child.mode)),
        encodeURIComponent(callId),
      ].join('/').replace(/^/, PLAN_PREFIX);
    }

    /**
     * Host 路由里的计划记录（`value.plans`，时间升序）→ 行表，**新的在前**。
     * 只保留能落成地址的条目：缺 callId 的记录点开也无处可去。
     */
    function planRows(value) {
      const plans = Array.isArray(value?.plans) ? value.plans : NO_ROWS;
      const rows = [];
      for (let index = plans.length - 1; index >= 0; index -= 1) {
        const plan = plans[index];
        if (plan === null || plan === undefined) continue;
        if (typeof plan.callId !== 'string' || plan.callId === '') continue;
        rows.push({
          key: plan.callId,
          callId: plan.callId,
          title: typeof plan.title === 'string' && plan.title !== '' ? plan.title : null,
        });
      }
      return rows.length === 0 ? NO_ROWS : rows;
    }

    /**
     * 目标操作的 CAS 引用：Host 的 edit/pause/resume/clear 都要 `{id, revision}`。
     * 缺字段时返回 null —— 此时只能显示，不能操作。
     */
    function goalRef(goal) {
      const current = goal?.goal;
      if (current === null || current === undefined) return null;
      if (typeof current.id !== 'string' || current.id === '') return null;
      if (typeof current.revision !== 'number') return null;
      return { id: current.id, revision: current.revision };
    }

    /** 目标阶段 → 可用操作；`activation`（armed/disarmed）不在投影里，故按 phase 判断。 */
    function goalActions(phase) {
      if (phase === 'active') return { pause: true, resume: false };
      if (phase === 'paused') return { pause: false, resume: true };
      return { pause: false, resume: false };
    }

    /** 找到主内容区元素：优先匹配当前会话（右栏可能同时存在子代理会话）。 */
    function pickContentElement(sessionId) {
      if (typeof document === 'undefined') return null;
      const all = document.querySelectorAll('[data-conversation-content]');
      let fallback = null;
      for (const element of all) {
        if (fallback === null) fallback = element;
        if (sessionId !== undefined && element.getAttribute('data-conversation-session') === sessionId) return element;
      }
      return fallback;
    }

    /**
     * 隐藏官方任务面板的目标元素：比锚点更严格——只有能**确定**是本会话那一代
     * （带会话标记精确匹配）或页面上只有一代内容区时才接管，避免多窗格时误标别人。
     */
    function pickHideTarget(sessionId) {
      if (typeof document === 'undefined') return null;
      const all = document.querySelectorAll('[data-conversation-content]');
      if (sessionId !== undefined) {
        for (const element of all) {
          if (element.getAttribute('data-conversation-session') === sessionId) return element;
        }
      }
      return all.length === 1 ? all[0] : null;
    }

    /** 锚点几何：内容区右上角在浮层坐标系里的落点。 */
    function anchorGeometry(layerRect, contentRect) {
      return {
        top: Math.round(contentRect.top - layerRect.top + ANCHOR_GAP),
        right: Math.round(layerRect.right - contentRect.right + ANCHOR_GAP),
      };
    }

    /**
     * 推让几何：算正文列要让开多少、左侧还有多少余量。
     *
     * 正文是**居中**列，右缘 = (W + C) / 2；卡片左缘 = W − (ANCHOR_GAP + 卡片宽)。
     * 于是 `need = C/2 − W/2 + reserve`，>0 就会压住正文；
     * `available = (W − C)/2 − PUSH_MIN_LEFT` 是推让的物理上限（再推正文就贴到内容区左缘）。
     * 推让量按 `padding-right = 2 * push` 施加：给宿主元素加右内边距会让居中列左移一半，
     * 且上限保证 `W − 2*available = C + 2*PUSH_MIN_LEFT ≥ C`，正文列宽度不会被压窄。
     *
     * @param contentWidth - 内容区宽度（像素）。
     * @param chatWidth - 正文列宽度（像素）。
     * @param reserve - 右侧要留出的宽度，默认「卡片 + 锚点间距 + 呼吸」。
     * @returns `{ need, available, push, tight }`；量不到宽度时一律「不需要推、不紧」。
     */
    function fitOf(contentWidth, chatWidth, reserve = ANCHOR_GAP + CARD_WIDTH + PUSH_TEXT_GAP) {
      if (typeof contentWidth !== 'number' || typeof chatWidth !== 'number') {
        return { need: 0, available: 0, push: 0, tight: false };
      }
      const need = chatWidth / 2 - contentWidth / 2 + reserve;
      const available = Math.max(0, (contentWidth - chatWidth) / 2 - PUSH_MIN_LEFT);
      return { need, available, push: Math.min(Math.max(need, 0), available), tight: need > available };
    }

    /** 正文列宽度的缓存：同一元素在同一内容区宽度下的解析结果不变，省掉反复插拔探针。 */
    const chatWidthCache = new WeakMap();

    /**
     * 正文列宽度：宿主把宽度写在 `--dsh-chat-content-width` 上，但值是 `clamp(…)`，
     * `getPropertyValue` 只能拿到原样字符串，必须落到真实元素上才算得出像素 ——
     * 所以真机走「临时探针」那条路，宿主（或测试）直接给 `Npx` 时走快路径。
     * 两条都失败一律返回 null：调用方据此退回降级保险丝，绝不拿猜的数字去推宿主布局。
     */
    function chatWidthOf(content, contentWidth) {
      if (content === null || typeof content !== 'object') return null;
      const cached = chatWidthCache.get(content);
      if (cached !== undefined && cached.width === contentWidth) return cached.value;
      const value = measureChatWidth(content);
      chatWidthCache.set(content, { width: contentWidth, value });
      return value;
    }

    function measureChatWidth(content) {
      const view = typeof getComputedStyle === 'function' ? getComputedStyle(content) : null;
      const raw = view === null || typeof view.getPropertyValue !== 'function'
        ? ''
        : String(view.getPropertyValue('--dsh-chat-content-width') ?? '').trim();
      const plain = /^(\d+(?:\.\d+)?)px$/u.exec(raw);
      if (plain !== null) return Number(plain[1]);
      if (raw === '') return null;
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
      if (content.style === undefined || content.style === null || typeof content.appendChild !== 'function') return null;
      const probe = document.createElement('div');
      probe.setAttribute('data-sc-probe', '');
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;height:0;overflow:hidden;pointer-events:none;width:var(--dsh-chat-content-width,0px)';
      content.appendChild(probe);
      const width = Math.round(probe.getBoundingClientRect().width);
      probe.remove();
      return width > 0 ? width : null;
    }

    /** 变更行表：只保留有坐标的合法行，并按上限截断。 */
    function changeRows(value) {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.files)) return NO_ROWS;
      return value.files
        .filter((file) => file !== null && typeof file === 'object' && typeof file.path === 'string')
        .slice(0, ROW_HARD_CAP);
    }

    /**
     * 把已去重的文件行按「本轮 / 更早」拆开。
     *
     * 官方在消息流末尾单独渲染一张「已编辑 N 个文件」（只含当轮），卡片这里是整会话去重视图：
     * 两段并排才能同时回答「这一轮改了什么」和「整个会话改了什么」。最后一轮由 Host 的
     * `lastTurn` 给出（与 `files[].turn` 同源），只有一轮时不摆分组头，避免噪声。
     *
     * @param value - Host 路由返回的变更值。
     * @param rows - 已经截到展示范围的行（分组只作用于展示出来的部分）。
     * @returns `{ current, earlier }`；不值得分组时返回 null。
     */
    function turnGroups(value, rows) {
      const lastTurn = value === null || typeof value !== 'object' ? null : value.lastTurn;
      if (typeof lastTurn !== 'number') return null;
      const current = rows.filter((file) => file.turn === lastTurn);
      const earlier = rows.filter((file) => file.turn !== lastTurn);
      if (current.length === 0 || earlier.length === 0) return null;
      return { current, earlier };
    }

    // #endregion

    // #region hooks

    /** 主会话：由 mainView 持有的那一代会话。 */
    function useMainSessionId(useSessions) {
      return useSessions((snapshot) => {
        for (const id of snapshot.ids) {
          if ((snapshot.byId[id]?.retainedBy?.mainView ?? 0) > 0) return id;
        }
        return undefined;
      });
    }

    /** 读某个投影键（宿主把投影值挂在列表行上）。 */
    function useSessionValue(useSessions, sessionId, key) {
      return useSessions((snapshot) => (sessionId === undefined ? undefined : snapshot.byId[sessionId]?.projectionValues?.[key]));
    }

    /**
     * 订阅一个惰性服务槽的当前值。
     *
     * 与 `useTheme` 同一个理由不用 `useSyncExternalStore`：测试里的 React 替身只实现了
     * `useState` / `useEffect`，用最朴素的两件套既够用，也让替身能跑通整条链。
     * @param slot `createServiceSlot()` 的返回值
     */
    function useServiceValue(slot) {
      const [value, setValue] = React.useState(() => slot.get());
      React.useEffect(() => {
        setValue(slot.get());
        return slot.subscribe(() => setValue(slot.get()));
      }, [slot]);
      return value;
    }

    /** 两版行表是否「看着一样」（比较每个行对象的引用，避免每次快照都重渲染整卡）。 */
    function sameRows(a, b) {
      if (a === b) return true;
      if (a.length !== b.length) return false;
      return a.every((row, i) => row === b[i]);
    }

    /**
     * 后台任务行表：订阅官方 `ctx.jobs` 的客户端 model，并为本会话开一条 roster 流
     * （`watchRows`，返回 disposer）。
     *
     * 服务缺席（没装 job controller，或那一行被禁用）时恒返回空表——这一节是加菜，
     * 不能因为后台任务服务不在就把整张卡片连坐。
     * @param jobs `ctx.jobs` 服务（惰性槽里可能还是 undefined）
     * @param sessionId 主会话 id
     */
    function useJobsRows(jobs, sessionId) {
      /** 读当前快照里的本会话行（服务或会话缺席时给稳定空表）。 */
      const readNow = () => {
        if (jobs === undefined || jobs === null || sessionId === undefined) return NO_ROWS;
        return jobs.state.getSnapshot().rows[String(sessionId)] ?? NO_ROWS;
      };
      const [rows, setRows] = React.useState(readNow);
      React.useEffect(() => {
        const read = () => (jobs === undefined || jobs === null || sessionId === undefined
          ? NO_ROWS
          : jobs.state.getSnapshot().rows[String(sessionId)] ?? NO_ROWS);
        const sync = () => setRows((prev) => {
          const next = read();
          return sameRows(prev, next) ? prev : next;
        });
        sync();
        if (jobs === undefined || jobs === null || sessionId === undefined) return undefined;
        const unsubscribe = jobs.state.subscribe(sync);
        const unwatch = jobs.watchRows(String(sessionId));
        return () => {
          unwatch();
          unsubscribe();
        };
      }, [jobs, sessionId]);
      return rows;
    }

    /**
     * 主内容区元素：先同步试一次，之后在 DOM 变化时复查（会话首帧、面板重挂都能追上）。
     * 复查只在当前元素缺失或已断开时做一次选择器查询，其余情况只做一次 isConnected 判断。
     */
    function useContentElement(sessionId) {
      const [element, setElement] = React.useState(() => pickContentElement(sessionId));
      const [attempt, setAttempt] = React.useState(0);
      React.useEffect(() => {
        setElement(pickContentElement(sessionId));
      }, [sessionId, attempt]);
      React.useEffect(() => {
        if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return undefined;
        const observer = new MutationObserver(() => {
          setElement((previous) => (previous !== null && previous.isConnected ? previous : pickContentElement(sessionId)));
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer.disconnect();
      }, [sessionId]);
      // 元素还没出现时，用若干帧的重试兜住「DOM 尚未挂载」的窗口。
      React.useEffect(() => {
        if (element !== null && element.isConnected) return undefined;
        let frame = 0;
        let handle = 0;
        const retry = () => {
          frame += 1;
          const next = pickContentElement(sessionId);
          if (next !== null && next.isConnected) {
            setElement(next);
            return;
          }
          if (frame < 600) handle = requestAnimationFrame(retry);
        };
        handle = requestAnimationFrame(retry);
        return () => cancelAnimationFrame(handle);
      }, [element, sessionId, attempt]);
      // 供外部手动催一次（例如会话切换后 DOM 复用）。
      React.useEffect(() => {
        const timer = setTimeout(() => setAttempt((value) => value + 1), 0);
        return () => clearTimeout(timer);
      }, [sessionId]);
      return element;
    }

    /**
     * 跟随主内容区矩形计算卡片锚点；内容区缺失时退回兜底位置。
     * 同时回传内容区**实时宽度**，供空间闸门（HIDE_BELOW_CONTENT_WIDTH）判断还放不放得下卡片。
     *
     * 首测走 layout effect：它必须在本帧 paint 之前完成，否则内容区本来就窄时，
     * 卡片会先画一帧再消失（肉眼可见的闪烁）。没有 useLayoutEffect 的极简宿主退化为 effect。
     */
    function useAnchor(anchorRef, content) {
      const [state, setState] = React.useState({ geometry: null, contentWidth: null, chatWidth: null });
      const useMeasure = React.useLayoutEffect ?? React.useEffect;
      useMeasure(() => {
        const measure = () => {
          const anchor = anchorRef.current;
          const layer = anchor === null ? null : anchor.offsetParent;
          const contentRect = content === null || !content.isConnected ? null : content.getBoundingClientRect();
          if (layer === null || contentRect === null || contentRect.width === 0 || contentRect.height === 0) {
            // 量不到内容区时只锁定位、不锁宽度：宽度未知一律当作「有空间」，
            // 维持原来的兜底显示行为，不能让测量失败变成卡片永久消失。
            setState((previous) => ({
              geometry: previous.geometry === null ? FALLBACK_ANCHOR : previous.geometry,
              contentWidth: null,
              chatWidth: null,
            }));
            return;
          }
          const geometry = anchorGeometry(layer.getBoundingClientRect(), contentRect);
          const contentWidth = Math.round(contentRect.width);
          // 尺寸没变就复用旧 state，避免 resize 期间的无谓重渲染。
          // 正文列宽度只在内容区宽度变化时重算（它是内容区宽度的函数，且有缓存）。
          setState((previous) => {
            const chatWidth = previous.contentWidth === contentWidth && previous.chatWidth !== null
              ? previous.chatWidth
              : chatWidthOf(content, contentWidth);
            return (previous.contentWidth === contentWidth
              && previous.chatWidth === chatWidth
              && previous.geometry !== null
              && previous.geometry.top === geometry.top
              && previous.geometry.right === geometry.right)
              ? previous
              : { geometry, contentWidth, chatWidth };
          });
        };
        measure();
        window.addEventListener('resize', measure);
        if (content === null) return () => window.removeEventListener('resize', measure);
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        if (observer !== null) observer.observe(content);
        return () => {
          window.removeEventListener('resize', measure);
          if (observer !== null) observer.disconnect();
        };
      }, [anchorRef, content]);
      return state;
    }

    /** 轮次结束（running 由 true 变 false）时自增，用来重新拉变更。 */
    function useTurnRevision(running) {
      const [revision, setRevision] = React.useState(0);
      const wasRunning = React.useRef(false);
      React.useEffect(() => {
        if (running === true) {
          wasRunning.current = true;
          return;
        }
        if (running === false && wasRunning.current) {
          wasRunning.current = false;
          setRevision((value) => value + 1);
        }
      }, [running]);
      return [revision, () => setRevision((value) => value + 1)];
    }

    /** 拉取整会话变更汇总；切换会话或轮次结束会重取，旧响应按 sessionId 丢弃。 */
    function useChanges(sessionId, revision, running) {
      const [state, setState] = React.useState({ status: 'idle', sessionId: undefined, value: null });
      // 运行中要每隔两秒重取一次本轮耗时（模型 / 工具时间是边走边涨的）；
      // 等待用户时只需要重渲染，「等你」由渲染时刻减去 `waitSince` 算出来。
      const [tick, setTick] = React.useState(0);
      // 还在等人回答时 `waitSince` 是一个绝对时刻：存在就每秒重渲染，「等你」由渲染时刻减去它算出来。
      // 轮次结束后没有未结算的等待，数字随之定格（轮次之间的空闲不算「等你」）。
      const timing = state.value?.timing;
      const liveSince = typeof timing?.waitSince === 'number' ? timing.waitSince : null;
      React.useEffect(() => {
        if (typeof setInterval !== 'function') return undefined;
        if (running === true) {
          const timer = setInterval(() => setTick((value) => value + 1), 2000);
          return () => clearInterval(timer);
        }
        if (liveSince === null) return undefined;
        const timer = setInterval(() => setTick((value) => value + 1), 1000);
        return () => clearInterval(timer);
      }, [running, liveSince]);
      React.useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        if (sessionId === undefined) {
          setState({ status: 'idle', sessionId: undefined, value: null });
          return () => controller.abort();
        }
        setState((previous) => (previous.sessionId === sessionId && previous.status === 'ok'
          ? { status: 'refreshing', sessionId, value: previous.value }
          : { status: 'loading', sessionId, value: null }));
        fetch(`${CHANGES_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        }).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        }).then((value) => {
          if (cancelled) return;
          setState({ status: 'ok', sessionId, value });
        }).catch(() => {
          if (cancelled || controller.signal.aborted) return;
          setState((previous) => (previous.sessionId === sessionId && previous.value !== null
            ? { ...previous, status: 'ok' }
            : { status: 'failed', sessionId, value: null }));
        });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [sessionId, revision, tick]);
      return state;
    }

    /**
     * 接管官方「任务」面板：标记主内容区元素，元素替换或卸载时撤掉标记。
     * `visible` 为 false（空间闸门收起了卡片）时必须撤掉标记——否则官方面板被藏、
     * 替代它的卡片又不显示，用户就彻底看不到任务了。
     */
    function useHideOfficialTodoDock(sessionId, content, visible) {
      React.useEffect(() => {
        if (!HIDE_OFFICIAL_TODO_DOCK || !visible) return undefined;
        // 只认「能确定属于本会话」的那一代内容区；锚点仍可用 fallback，接管不吃这个风险。
        const target = pickHideTarget(sessionId);
        if (target === null) return undefined;
        target.setAttribute(HIDE_TODO_ATTR, '');
        return () => target.removeAttribute(HIDE_TODO_ATTR);
      }, [sessionId, content, visible]);
    }

    /** 正在被改写 padding 的宿主元素与它原来的 padding-right（单实例卡片，模块级足够）。 */
    let paddedElement = null;
    let paddedOriginal = '';

    /** 上一次「自动判定」的结果，只用来做收起↔展开的滞回，免得宽度在临界点抖。 */
    let autoCollapsed = false;

    const readPadding = (element) => {
      const style = element === null || element === undefined ? undefined : element.style;
      return style === undefined || style === null ? '' : String(style.paddingRight ?? '');
    };

    const writePadding = (element, value) => {
      const style = element === null || element === undefined ? undefined : element.style;
      if (style === undefined || style === null) return;
      style.paddingRight = value;
    };

    /**
     * 会话区自适应：内容区变窄时先把正文**向左推**让出卡片，让到极限就自动收起，变宽了再自动展开。
     *
     * 折叠态为什么放在这个 hook 里：`test/smoke.mjs` 的迷你 React 按全局调用序号分配 hook 槽位，
     * `StatusCard` 的 hook 数量一变，块出现/消失的那一帧就会错位（见「伸缩动画」那轮的教训）。
     * 所以这里是**替换**掉 `StatusCard` 原来的 `useState(collapsedMemory)` + 记忆 effect，
     * 而不是在其之上再叠加新 hook。
     *
     * 手动操作的语义：只对**当前宽度格局**有效（`signature = 内容区宽:正文列宽`）。用户要求
     * 「手动展开后再触发宽度变化则继续收起」——格局一变 `wanted` 就置空，判定回到自动逻辑。
     *
     * @param options.content - 宿主主内容区元素（用于写 padding）。
     * @param options.contentWidth - 内容区宽度，null 表示没量到。
     * @param options.chatWidth - 正文列宽度，null 表示宿主没暴露/解析失败。
     * @returns `{ collapsed, tight, padding, setCollapsed }`
     */
    function useCardLayout({ content, contentWidth, chatWidth }) {
      const [manual, setManual] = React.useState(null);
      const measurable = typeof contentWidth === 'number' && typeof chatWidth === 'number';
      const signature = measurable ? `${contentWidth}:${chatWidth}` : '';
      const fit = fitOf(contentWidth, chatWidth, ANCHOR_GAP + CARD_WIDTH + PUSH_TEXT_GAP);
      // 收起态只需要给那颗圆钮让位，不必让出整张卡片。
      const fabFit = fitOf(contentWidth, chatWidth, PUSH_FAB);
      const wanted = manual !== null && manual.signature === signature ? manual.collapsed : null;
      // 滞回：上一轮是自动收起的，这一轮要多出 FIT_HYSTERESIS 的余量才自动展开，免得临界点上抖。
      const slack = autoCollapsed ? FIT_HYSTERESIS : 0;
      const autoTight = measurable && fit.need > fit.available - slack;
      const collapsed = wanted !== null ? wanted : (measurable ? autoTight : collapsedMemory);
      // 推让施加在宿主的 padding-right 上：居中列会左移一半，所以是 2 倍。
      const padding = Math.round((collapsed ? fabFit.push : fit.push) * 2);

      React.useEffect(() => {
        collapsedMemory = collapsed;
        // 只在「没有手动态」时记录自动判定结果：手动开合不该污染滞回基线。
        if (wanted === null && measurable) autoCollapsed = collapsed;
      }, [collapsed, wanted, measurable]);

      React.useEffect(() => {
        const target = content !== null && content !== undefined && content.isConnected !== false ? content : null;
        if (paddedElement !== null && paddedElement !== target) {
          writePadding(paddedElement, paddedOriginal);
          paddedElement = null;
        }
        if (target === null) return undefined;
        if (paddedElement === null) {
          paddedElement = target;
          paddedOriginal = readPadding(target);
        }
        writePadding(target, padding === 0 ? paddedOriginal : `${padding}px`);
        return undefined;
      }, [content, padding]);

      // 卸载时把宿主元素还原回原样，别把 padding 留在别人的 DOM 上。
      React.useEffect(() => () => {
        if (paddedElement === null) return;
        writePadding(paddedElement, paddedOriginal);
        paddedElement = null;
      }, []);

      const setCollapsed = (next) => setManual({ signature, collapsed: next });
      return { collapsed, tight: autoTight, padding, setCollapsed };
    }

    // #endregion

    // #region 展示块（纯 props，便于直接调用断言）

    /** 自绘线性图标：官方图标属于 primitives、规范不可引用，这里统一 16px、stroke 取 currentColor。 */
    const ICON_PATHS = {
      task: ['M2.8 4.6h10.4', 'M2.8 8h10.4', 'M2.8 11.4h6.4'],
      plan: ['M3.2 8.4l2.8 2.8 6.8-6.8'],
      goal: ['M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9z', 'M8 5.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z'],
      permission: ['M8 1.9l4.9 1.9v4.5c0 2.8-2 4.8-4.9 5.7-2.9-.9-4.9-2.9-4.9-5.7V3.8z'],
      sandbox: ['M3.1 2.7h9.8v10.6H3.1z', 'M3.1 6.6h9.8'],
      file: ['M4.2 1.9h4.6L11.9 5v9.1H4.2z', 'M8.8 1.9V5h3.1'],
      agents: ['M8 7.7a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z', 'M3.4 14c0-2.3 2-3.8 4.6-3.8s4.6 1.5 4.6 3.8'],
      subagent: ['M4.7 3.4v9.2', 'M11.3 6.6v1a2.4 2.4 0 0 1-2.4 2.4H7.1', 'M4.7 3.4h3.4'],
      chevronDown: ['M4.2 6.4L8 10.2l3.8-3.8'],
      // 实心方块（按 filled 渲染）：宿主「后台任务」面板的停止按钮就是这颗 10px 的方块。
      stop: ['M4.6 4.6h6.8v6.8H4.6z'],
      chevronRight: ['M6.4 4.2l3.8 3.8-3.8 3.8'],
      chevronLeft: ['M9.6 4.2L5.8 8l3.8 3.8'],
      refresh: ['M12.9 8a4.9 4.9 0 1 1-1.5-3.6', 'M13.1 2.8v3.1H10'],
      dot: ['M8 6.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z'],
      edit: ['M10.6 2.9l2.5 2.5', 'M11.8 1.7a1.1 1.1 0 0 1 1.6 0l.9.9a1.1 1.1 0 0 1 0 1.6l-7.6 7.6-3.3.8.8-3.3z'],
      pause: ['M6.1 3.4v9.2', 'M9.9 3.4v9.2'],
      play: ['M5.4 3.2l7.3 4.8-7.3 4.8z'],
      trash: ['M2.9 4.4h10.2', 'M6.2 4.4V2.9h3.6v1.5', 'M4.4 4.4l.6 8.2a.9.9 0 0 0 .9.8h4.2a.9.9 0 0 0 .9-.8l.6-8.2'],
      doc: ['M4.2 1.9h4.6L11.9 5v9.1H4.2z', 'M8.8 1.9V5h3.1', 'M6 8.3h4.1', 'M6 10.7h4.1'],
      external: ['M9.6 2.4h4v4', 'M13.6 2.4L8 8', 'M12 9.7v3.1a.8.8 0 0 1-.8.8H3.2a.8.8 0 0 1-.8-.8V4.8a.8.8 0 0 1 .8-.8h3.2'],
      check: ['M3.4 8.2l3 3 6.2-6.4'],
      // 灯泡：线性灯罩 + 灯座两条线 + 周围三颗发光点（点用极短线段画，图标统一 stroke 渲染）。
      bulb: [
        'M8 3.2a3.4 3.4 0 0 0-2 6.2c.3.2.5.6.5.9v.4h3v-.4c0-.3.2-.7.5-.9A3.4 3.4 0 0 0 8 3.2z',
        'M6.6 12.1h2.8',
        'M7.3 13.7h1.4',
        'M8 1.1v.6',
        'M2.6 4.3l.5.3',
        'M13.4 4.3l-.5.3',
        'M3 8.9l.6-.2',
        'M13 8.9l-.6-.2',
      ],
    };

    /**
     * 装饰性图标（`aria-hidden`，语义由相邻文本承担）。
     * @param props.name 图标名，未知名回退圆点
     * @param props.size 边长，默认 16
     */
    function Icon({ name, size = 14, filled = false }) {
      const paths = ICON_PATHS[name] ?? ICON_PATHS.dot;
      return h('svg', {
        className: 'sc_icon',
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: filled ? 'currentColor' : 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, paths.map((d, index) => h('path', { key: index, d })));
    }

    /**
     * 文件类型图标：页形 + 折角 + 类型标记的几何取自宿主侧边栏「工作区文件」那一套（同一份 path 数据）。
     * 不 import primitives，所以把几何抄进来；颜色一律走 `--dsw-static-*` token，由 CSS 按 `data-kind` 上色，
     * 保证同一个类型在卡片里和侧边栏是同一个颜色。`other` 只画一张淡色页形，与官方一致。
     */
    const FILE_PAGE = 'M8.48924 28H19.5108C21.6479 28 22.7165 28 23.5594 27.6509C24.6833 27.1853 25.5762 26.2924 26.0417 25.1685C26.3909 24.3256 26.3909 23.257 26.3909 21.1199V8.79443C26.3909 8.32877 26.3909 8.09593 26.3471 7.87507C26.2887 7.58058 26.173 7.30042 26.0067 7.05048C25.882 6.86303 25.7177 6.69799 25.3893 6.36792L20.0611 1.01354C19.7304 0.681235 19.5651 0.515081 19.3769 0.38885C19.126 0.220541 18.8443 0.103463 18.5481 0.0443412C18.3259 0 18.0915 0 17.6226 0H8.48924C6.35209 0 5.28351 0 4.4406 0.349145C3.31672 0.814671 2.4238 1.70759 1.95828 2.83147C1.60913 3.67438 1.60913 4.74296 1.60913 6.88011V21.1199C1.60913 23.257 1.60913 24.3256 1.95828 25.1685C2.4238 26.2924 3.31672 27.1853 4.4406 27.6509C5.28351 28 6.35209 28 8.48924 28Z';
    const FILE_FOLD = 'M26.3909 7.37445L19.0525 0V3.77445C19.0525 4.89271 19.0525 5.45184 19.2352 5.89289C19.4788 6.48096 19.946 6.94818 20.5341 7.19176C20.9751 7.37445 21.5342 7.37445 22.6525 7.37445H26.3909Z';
    const FILE_MARK_SCALE_SMALL = 'translate(14 16) scale(1.12) translate(-14 -16)';
    const FILE_MARK_SCALE_LARGE = 'translate(14 16) scale(1.22) translate(-14 -16)';
    const FILE_MARKS = {
      code: {
        transform: null,
        paths: [
          { d: 'M10.0053 13.126L7.0236 16.3788C6.96052 16.4476 6.96052 16.5532 7.0236 16.622L10.0053 19.8748', stroke: '1.35' },
          { d: 'M17.9941 13.126L20.9759 16.3788C21.039 16.4476 21.039 16.5532 20.9759 16.622L17.9941 19.8748', stroke: '1.35' },
          { d: 'M15.2652 12.957L12.7344 20.0433', stroke: '1.35' },
        ],
      },
      markdown: {
        transform: FILE_MARK_SCALE_LARGE,
        paths: [
          { d: 'M8.7588 19.5V14.6H9.8998L11.9298 17.932H11.3278L13.3018 14.6H14.4428L14.4568 19.5H13.1828L13.1688 16.539H13.3858L11.9088 19.017H11.2928L9.7738 16.539H10.0398V19.5H8.7588ZM15.4375 19.5V14.6H17.7545C18.2958 14.6 18.7718 14.7003 19.1825 14.901C19.5932 15.1017 19.9128 15.384 20.1415 15.748C20.3748 16.112 20.4915 16.546 20.4915 17.05C20.4915 17.5493 20.3748 17.9833 20.1415 18.352C19.9128 18.716 19.5932 18.9983 19.1825 19.199C18.7718 19.3997 18.2958 19.5 17.7545 19.5H15.4375ZM16.8235 18.394H17.6985C17.9785 18.394 18.2212 18.3427 18.4265 18.24C18.6365 18.1327 18.7998 17.9787 18.9165 17.778C19.0332 17.5727 19.0915 17.33 19.0915 17.05C19.0915 16.7653 19.0332 16.5227 18.9165 16.322C18.7998 16.1213 18.6365 15.9697 18.4265 15.867C18.2212 15.7597 17.9785 15.706 17.6985 15.706H16.8235V18.394Z', fill: true },
        ],
      },
      excel: {
        transform: null,
        paths: [
          { d: 'M14 11.5H11.4C10.5599 11.5 10.1399 11.5 9.81901 11.6635C9.53677 11.8073 9.3073 12.0368 9.16349 12.319C9 12.6399 9 13.0599 9 13.9V16.5M14 11.5H16.6C17.4401 11.5 17.8601 11.5 18.181 11.6635C18.4632 11.8073 18.6927 12.0368 18.8365 12.319C19 12.6399 19 13.0599 19 13.9V16.5M14 11.5V21.5M14 21.5H16.6C17.4401 21.5 17.8601 21.5 18.181 21.3365C18.4632 21.1927 18.6927 20.9632 18.8365 20.681C19 20.3601 19 19.9401 19 19.1V16.5M14 21.5H11.4C10.5599 21.5 10.1399 21.5 9.81901 21.3365C9.53677 21.1927 9.3073 20.9632 9.16349 20.681C9 20.3601 9 19.9401 9 19.1V16.5M19 16.5H9', stroke: '1.2' },
        ],
      },
      html: {
        transform: FILE_MARK_SCALE_SMALL,
        paths: [
          { d: 'M13.9994 9.68298C17.212 9.68298 19.8167 12.2872 19.8168 15.4997C19.8168 18.7123 17.2121 21.3171 13.9994 21.3171C10.7869 21.3169 8.18274 18.7122 8.18274 15.4997C8.1829 12.2873 10.787 9.68315 13.9994 9.68298ZM9.26213 16.0247C9.47025 17.9241 10.7936 19.4876 12.5639 20.0463C12.42 19.7977 12.2952 19.5152 12.1879 19.2116C11.885 18.3541 11.693 17.2434 11.6424 16.0247H9.26213ZM16.3565 16.0247C16.3059 17.2434 16.1145 18.3542 15.8116 19.2116C15.7044 19.5151 15.5788 19.7971 15.435 20.0456C17.2054 19.487 18.5293 17.9242 18.7374 16.0247H16.3565ZM12.6938 16.0247C12.7439 17.1459 12.9212 18.1334 13.1784 18.8616C13.332 19.2962 13.503 19.61 13.6686 19.805C13.834 19.9996 13.9473 20.0256 13.9994 20.0258C14.0514 20.0258 14.1651 20.0002 14.331 19.805C14.4966 19.61 14.6676 19.2962 14.8211 18.8616C15.0784 18.1334 15.2557 17.1459 15.3058 16.0247H12.6938ZM13.9994 10.733C13.9473 10.7331 13.834 10.7598 13.6686 10.9545C13.503 11.1494 13.3319 11.4633 13.1784 11.8978C12.903 12.6777 12.7188 13.7545 12.6849 14.9747H15.3147C15.2808 13.7545 15.0966 12.6777 14.8211 11.8978C14.6676 11.4633 14.4965 11.1494 14.331 10.9545C14.1651 10.7593 14.0514 10.733 13.9994 10.733ZM15.5888 11.0051C15.6701 11.1756 15.7444 11.3576 15.8116 11.5478C16.1343 12.4613 16.3308 13.6619 16.3647 14.9747H18.7374C18.5352 13.1307 17.2817 11.6036 15.5888 11.0051ZM12.4101 11.0051C10.7174 11.6037 9.46428 13.1308 9.26213 14.9747H11.6349C11.6688 13.6619 11.8652 12.4613 12.1879 11.5478C12.2551 11.3577 12.3288 11.1756 12.4101 11.0051Z', fill: true },
        ],
      },
      image: {
        transform: FILE_MARK_SCALE_SMALL,
        paths: [
          { d: 'M10.4212 15.9204C10.5756 15.6558 10.9579 15.6558 11.1123 15.9204L13.6493 20.2696C13.8048 20.5362 13.6125 20.8711 13.3037 20.8711H8.22974C7.92102 20.8711 7.72868 20.5362 7.88423 20.2696L10.4212 15.9204Z', fill: true },
          { d: 'M15.4981 13.186C15.6505 12.9117 16.0451 12.9117 16.1975 13.186L20.1368 20.2769C20.2849 20.5435 20.0922 20.8711 19.7872 20.8711H11.9084C11.6034 20.8711 11.4107 20.5435 11.5588 20.2769L15.4981 13.186Z', fill: true },
          { d: 'M11.8603 11.3997C11.8603 12.286 11.1418 13.0045 10.2555 13.0045C9.36924 13.0045 8.65076 12.286 8.65076 11.3997C8.65076 10.5134 9.36924 9.79492 10.2555 9.79492C11.1418 9.79492 11.8603 10.5134 11.8603 11.3997Z', fill: true },
        ],
      },
      pdf: {
        transform: FILE_MARK_SCALE_LARGE,
        paths: [
          { d: 'M6.80616 19.5V14.6H9.04616C9.49416 14.6 9.87916 14.6723 10.2012 14.817C10.5278 14.9617 10.7798 15.1717 10.9572 15.447C11.1345 15.7177 11.2232 16.0397 11.2232 16.413C11.2232 16.7817 11.1345 17.1013 10.9572 17.372C10.7798 17.6427 10.5278 17.8527 10.2012 18.002C9.87916 18.1467 9.49416 18.219 9.04616 18.219H7.57616L8.19216 17.617V19.5H6.80616ZM8.19216 17.764L7.57616 17.127H8.96216C9.2515 17.127 9.46616 17.064 9.60616 16.938C9.75083 16.812 9.82316 16.637 9.82316 16.413C9.82316 16.1843 9.75083 16.007 9.60616 15.881C9.46616 15.755 9.2515 15.692 8.96216 15.692H7.57616L8.19216 15.055V17.764ZM11.8989 19.5V14.6H14.2159C14.7573 14.6 15.2333 14.7003 15.6439 14.901C16.0546 15.1017 16.3743 15.384 16.6029 15.748C16.8363 16.112 16.9529 16.546 16.9529 17.05C16.9529 17.5493 16.8363 17.9833 16.6029 18.352C16.3743 18.716 16.0546 18.9983 15.6439 19.199C15.2333 19.3997 14.7573 19.5 14.2159 19.5H11.8989ZM13.2849 18.394H14.1599C14.4399 18.394 14.6826 18.3427 14.8879 18.24C15.0979 18.1327 15.2613 17.9787 15.3779 17.778C15.4946 17.5727 15.5529 17.33 15.5529 17.05C15.5529 16.7653 15.4946 16.5227 15.3779 16.322C15.2613 16.1213 15.0979 15.9697 14.8879 15.867C14.6826 15.7597 14.4399 15.706 14.1599 15.706H13.2849V18.394ZM17.6821 19.5V14.6H21.5251V15.671H19.0681V19.5H17.6821ZM18.9701 17.82V16.749H21.2311V17.82H18.9701Z', fill: true },
        ],
      },
      ppt: {
        transform: FILE_MARK_SCALE_LARGE,
        paths: [
          { d: 'M11.0132 20.5V13.5H14.2132C14.8532 13.5 15.4032 13.6033 15.8632 13.81C16.3299 14.0167 16.6899 14.3167 16.9432 14.71C17.1966 15.0967 17.3232 15.5567 17.3232 16.09C17.3232 16.6167 17.1966 17.0733 16.9432 17.46C16.6899 17.8467 16.3299 18.1467 15.8632 18.36C15.4032 18.5667 14.8532 18.67 14.2132 18.67H12.1132L12.9932 17.81V20.5H11.0132ZM12.9932 18.02L12.1132 17.11H14.0932C14.5066 17.11 14.8132 17.02 15.0132 16.84C15.2199 16.66 15.3232 16.41 15.3232 16.09C15.3232 15.7633 15.2199 15.51 15.0132 15.33C14.8132 15.15 14.5066 15.06 14.0932 15.06H12.1132L12.9932 14.15V18.02Z', fill: true },
        ],
      },
      video: {
        transform: FILE_MARK_SCALE_SMALL,
        paths: [
          { d: 'M17.5 14.634C18.1667 15.0189 18.1667 15.9811 17.5 16.366L11.5 19.8301C10.8333 20.215 10 19.7339 10 18.9641L10 12.0359C10 11.2661 10.8333 10.785 11.5 11.1699L17.5 14.634Z', fill: true },
        ],
      },
      braces: {
        transform: FILE_MARK_SCALE_SMALL,
        paths: [
          { d: 'M12.2 12.4c-1.2 0-1.7.5-1.7 1.8v.8c0 1-.5 1.5-1.4 1.5.9 0 1.4.5 1.4 1.5v.8c0 1.3.5 1.8 1.7 1.8', stroke: '1.5' },
          { d: 'M15.8 12.4c1.2 0 1.7.5 1.7 1.8v.8c0 1 .5 1.5 1.4 1.5-.9 0-1.4.5-1.4 1.5v.8c0 1.3-.5 1.8-1.7 1.8', stroke: '1.5' },
        ],
      },
      hash: {
        transform: null,
        paths: [
          { d: 'M12.7 11.9L11.5 20.1', stroke: '1.5' },
          { d: 'M17.1 11.9L15.9 20.1', stroke: '1.5' },
          { d: 'M10.1 14.6H18.3', stroke: '1.5' },
          { d: 'M9.7 17.4H17.9', stroke: '1.5' },
        ],
      },
      terminal: {
        transform: null,
        paths: [
          { d: 'M10.4 13.2L13.2 16L10.4 18.8', stroke: '1.5' },
          { d: 'M14.6 18.8H18.4', stroke: '1.5' },
        ],
      },
      lines: {
        transform: null,
        paths: [
          { d: 'M9.9 13.2H18.1', stroke: '1.5' },
          { d: 'M9.9 16H18.1', stroke: '1.5' },
          { d: 'M9.9 18.8H14.6', stroke: '1.5' },
        ],
      },
      word: {
        transform: FILE_MARK_SCALE_LARGE,
        paths: [
          { d: 'M10.5118 20.5L8.24179 13.5H10.2818L12.1918 19.56H11.1618L13.1718 13.5H14.9918L16.8918 19.56H15.9018L17.8718 13.5H19.7618L17.4918 20.5H15.3718L13.7518 15.35H14.3218L12.6318 20.5H10.5118Z', fill: true },
        ],
      },
    };
    // 语言之间先靠颜色分家（见 `.sc_fileIcon[data-kind=…]`），标记复用四种常见字形：
    // 括号（脚本类）、花括号（json）、井号（样式）、终端提示符（shell）、三条线（键值配置）。
    FILE_MARKS.javascript = FILE_MARKS.code;
    FILE_MARKS.typescript = FILE_MARKS.code;
    FILE_MARKS.python = FILE_MARKS.code;
    FILE_MARKS.rust = FILE_MARKS.code;
    FILE_MARKS.go = FILE_MARKS.code;
    FILE_MARKS.java = FILE_MARKS.code;
    FILE_MARKS.clang = FILE_MARKS.code;
    FILE_MARKS.sql = FILE_MARKS.code;
    FILE_MARKS.json = FILE_MARKS.braces;
    FILE_MARKS.stylesheet = FILE_MARKS.hash;
    FILE_MARKS.shell = FILE_MARKS.terminal;
    FILE_MARKS.config = FILE_MARKS.lines;

    /** 官方 formatTokens 的取整口径：≥10 取整，否则保留一位小数。 */
    function scaledNumber(value) {
      return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
    }

    /** `tokenUsage` 投影 → 累计 token 总数（四个桶互斥，reasoning 已含在 output 里）。 */
    function tokenTotal(usage) {
      if (usage === null || usage === undefined || typeof usage !== 'object') return null;
      const fields = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
      let total = 0;
      let seen = false;
      for (const field of fields) {
        const value = usage[field];
        if (typeof value === 'number' && Number.isFinite(value)) {
          total += value;
          seen = true;
        }
      }
      return seen ? total : null;
    }

    /** token 总数 → 「4.8M tok」（与官方 ui-subagent 的 tokens.* 同一档位与后缀）。 */
    function formatTokens(t, total) {
      if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
      if (total < 1e3) return t('agents.metrics.tokens', { value: String(total) });
      if (total < 1e6) return t('agents.metrics.tokens', { value: t('agents.tokens.k', { value: String(scaledNumber(total / 1e3)) }) });
      return t('agents.metrics.tokens', { value: t('agents.tokens.m', { value: String(scaledNumber(total / 1e6)) }) });
    }

    /** 毫秒 → 「3分33秒」四档（与官方 formatDuration 同文案）。 */
    function formatDuration(t, ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return t('agents.duration.seconds', { seconds: String(seconds) });
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) {
        return t('agents.duration.minutes', { minutes: String(minutes), seconds: String(seconds % 60) });
      }
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        return t('agents.duration.hours', {
          hours: String(hours),
          minutes: String(minutes % 60),
          seconds: String(seconds % 60),
        });
      }
      const days = Math.floor(hours / 24);
      return t('agents.duration.days', {
        days: String(days),
        hours: String(hours % 24),
      });
    }

    /**
     * 紧凑时长：`42s` / `3m12s` / `1h05m`。
     *
     * 状态条一格要放三段，用官方那种「3分12秒」会把整行撑开；这里只留单位字母，
     * 中文与英文界面都读得通（数字才是重点）。
     */
    /** 容错把宿主给的毫秒数当数字用（缺字段 / NaN 一律当 0）。 */
    function clockOf(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    }

    function formatClock(ms) {
      const total = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
      const seconds = total % 60;
      const minutes = Math.floor(total / 60) % 60;
      const hours = Math.floor(total / 3600);
      if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
      if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
      return `${seconds}s`;
    }

    /** 后台任务是否「还在跑」：stopping 也算——任务没结算，行就不该滑到已结束那堆里。 */
    function jobIsLive(job) {
      return job?.status === 'running' || job?.status === 'stopping';
    }

    /** 后台任务行序：运行中的按启动时间正序在前，已结束的按结束时间倒序在后（与官方面板一致）。 */
    function jobOrder(rows) {
      return [...rows].sort((left, right) => {
        const liveLeft = jobIsLive(left);
        if (liveLeft !== jobIsLive(right)) return liveLeft ? -1 : 1;
        if (liveLeft) return clockOf(left.startedAt) - clockOf(right.startedAt);
        const gap = clockOf(right.finishedAt ?? right.startedAt) - clockOf(left.finishedAt ?? left.startedAt);
        return gap !== 0 ? gap : clockOf(left.startedAt) - clockOf(right.startedAt);
      });
    }

    /** 后台任务状态 → 圆点语义（复用状态条的 running 转圈与 done / warn / error 三档）。 */
    function jobMark(status) {
      if (status === 'running' || status === 'stopping') return 'running';
      if (status === 'completed') return 'done';
      if (status === 'killed') return 'warn';
      return 'error';
    }

    /** 后台任务状态 → 文案键；未知状态按「已完成」兜底，不把英文枚举直接甩到界面上。 */
    function jobStatusKey(status) {
      if (status === 'running') return 'jobs.status.running';
      if (status === 'stopping') return 'jobs.status.stopping';
      if (status === 'killed') return 'jobs.status.killed';
      if (status === 'failed') return 'jobs.status.failed';
      return 'jobs.status.completed';
    }

    /**
     * 后台任务时长：最多两档（秒 / 分秒 / 时分），文案与宿主「后台任务」面板逐字一致
     * ——两处指向同一件事，措辞与取舍（超过一小时就不再往下补天数）不该分叉。
     * @param t 翻译函数
     * @param ms 毫秒
     */
    function jobDuration(t, ms) {
      const total = Math.max(0, Math.floor(clockOf(ms) / 1000));
      const seconds = total % 60;
      const minutes = Math.floor(total / 60) % 60;
      const hours = Math.floor(total / 3600);
      if (hours > 0) return t('jobs.duration.hours', { hours, minutes });
      if (minutes > 0) return t('jobs.duration.minutes', { minutes, seconds });
      return t('jobs.duration.seconds', { seconds });
    }

    /**
     * Host 路由里的本轮耗时（`value.timing`）→ 状态条的三段。
     *
     * 「等你」= 这一轮里人真正卡住 agent 的时间：提问 / 计划批准 / 审批已经结算进 `waitMs`；
     * 还在等人时用 `waitSince` 往后顺延（绝对时刻，所以即使不重新请求，每次重渲染也能算出更长的
     * 等待，由 `useChanges` 的秒级 tick 驱动）。轮次结束（`turn/end`）之后数字定格——
     * 轮次之间的空闲（用户看回答 / 想下一步 / 离开）不算「等你」，否则对话结束后它还会一直涨。
     * 三段互不重叠（宿主已把审批时间从工具耗时里扣掉），总和不会超过这一轮的墙钟。
     */
    function timingSegments(t, value, now) {
      const timing = value?.timing;
      if (timing === null || timing === undefined) return NO_ROWS;
      if (typeof timing.turn !== 'number') return NO_ROWS;
      const modelMs = clockOf(timing.modelMs);
      const toolMs = clockOf(timing.toolMs);
      const waitMs = clockOf(timing.waitMs);
      // 还在等人时，`waitSince` 是那一瞬的绝对时刻：不重新请求也能算出已经等了多久。
      const liveWait = typeof timing.waitSince === 'number' && typeof now === 'number'
        ? Math.max(0, now - timing.waitSince)
        : 0;
      const waited = waitMs + liveWait;
      const totalMs = modelMs + toolMs + waited;
      const segments = [
        // 第一段是本轮总耗时：与后面三段同一档（12px / 600 / fg），不再单独放大，只靠位置站队首。
        { key: 'total', name: t('timing.total'), value: formatClock(totalMs), total: true },
        { key: 'model', name: t('timing.model'), value: formatClock(modelMs) },
        { key: 'tool', name: t('timing.tool'), value: formatClock(toolMs) },
      ];
      if (waited > 0) {
        segments.push({ key: 'wait', name: t('timing.wait'), value: formatClock(waited) });
      }
      return segments;
    }

    /**
     * 子智能体的活跃耗时：`settledMs` + 当前活跃窗（运行中用渲染时刻，结束用 `through`）。
     * 与官方 `activityDuration` 同算法，差别只在「现在」由渲染时刻提供（卡片不挂定时器）。
     */
    function subagentDuration(row, now) {
      const settled = typeof row?.settledMs === 'number' && Number.isFinite(row.settledMs) ? row.settledMs : 0;
      if (typeof row?.activeSince !== 'number') return settled;
      const through = row.running
        ? now
        : (typeof row.activeThrough === 'number' ? row.activeThrough : row.activeSince);
      return settled + Math.max(0, through - row.activeSince);
    }

    /** 扩展名 → 通用文件类型（与侧边栏同一套归类口径；品牌类型在这里统一落到 code）。 */
    const FILE_EXT_KINDS = {
      md: 'markdown', mdx: 'markdown', markdown: 'markdown',
      csv: 'excel', tsv: 'excel', xls: 'excel', xlsx: 'excel', xlsm: 'excel', ods: 'excel',
      html: 'html', htm: 'html',
      png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image',
      avif: 'image', bmp: 'image', ico: 'image', tif: 'image', tiff: 'image',
      pdf: 'pdf',
      ppt: 'ppt', pptx: 'ppt', key: 'ppt',
      doc: 'word', docx: 'word', rtf: 'word', odt: 'word',
      mp4: 'video', mov: 'video', m4v: 'video', webm: 'video', mkv: 'video', avi: 'video',
      // 代码再按语言分家：颜色 + 标记都不同，一眼能分出 js / ts / json / py / rs / go…
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
      json: 'json', json5: 'json', jsonc: 'json',
      py: 'python', pyi: 'python',
      rs: 'rust',
      go: 'go',
      java: 'java', kt: 'java', kts: 'java', scala: 'java', groovy: 'java', clj: 'java', cljs: 'java',
      c: 'clang', cc: 'clang', cpp: 'clang', cxx: 'clang', h: 'clang', hh: 'clang', hpp: 'clang',
      cs: 'clang', swift: 'clang', m: 'clang', mm: 'clang',
      sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'shell', bat: 'shell', cmd: 'shell',
      css: 'stylesheet', scss: 'stylesheet', sass: 'stylesheet', less: 'stylesheet',
      yaml: 'config', yml: 'config', toml: 'config', ini: 'config', env: 'config', conf: 'config',
      sql: 'sql',
    };
    /** 无扩展名或按文件名认的类型（README / CHANGELOG 一律当 markdown）。 */
    const FILE_NAME_KINDS = {
      readme: 'markdown', changelog: 'markdown', contributing: 'markdown',
      dockerfile: 'code', makefile: 'code', gnumakefile: 'code', rakefile: 'code',
    };
    const FILE_CODE_EXTS = new Set([
      'vue', 'svelte', 'astro', 'xml', 'rb', 'php', 'proto', 'graphql', 'gql', 'lua', 'r', 'pl',
      'ex', 'exs', 'erl', 'hs', 'dart', 'lock', 'mod', 'sum',
    ]);

    /** 文件名 → 通用类型：先按整名（README）、再按扩展名，认不出就是 other。 */
    function fileKindOf(path) {
      const name = basename(String(path ?? '')).toLowerCase();
      const dot = name.lastIndexOf('.');
      const stem = dot <= 0 ? name : name.slice(0, dot);
      const ext = dot <= 0 ? '' : name.slice(dot + 1);
      if (FILE_NAME_KINDS[stem] !== undefined) return FILE_NAME_KINDS[stem];
      if (FILE_EXT_KINDS[ext] !== undefined) return FILE_EXT_KINDS[ext];
      if (FILE_CODE_EXTS.has(ext)) return 'code';
      return 'other';
    }

    /**
     * 彩色文件类型图标（16px）：色块页形 + 白色类型标记，和侧边栏「工作区文件」里的文件行同款。
     * 颜色不写在组件里，由 `.sc_fileIcon[data-kind=…]` 统一上色。
     */
    function FileIcon({ path, size = 16 }) {
      const kind = fileKindOf(path);
      const mark = FILE_MARKS[kind];
      const children = [
        h('path', { key: 'page', d: FILE_PAGE, fill: 'currentColor' }),
        kind === 'other'
          ? h('path', { key: 'fold', d: FILE_FOLD, fill: 'var(--dsw-static-neutral-400)' })
          : h('path', { key: 'fold', d: FILE_FOLD, fill: 'var(--dsw-static-neutral-00)', fillOpacity: 0.7 }),
      ];
      if (mark !== undefined) {
        children.push(h('g', {
          key: 'mark',
          color: 'var(--dsw-static-neutral-00)',
          'data-file-type-mark': true,
          transform: mark.transform ?? undefined,
        }, mark.paths.map((item, index) => h('path', item.stroke === undefined
          ? { key: index, d: item.d, fill: 'currentColor' }
          : { key: index, d: item.d, fill: 'none', stroke: 'currentColor', strokeWidth: item.stroke }))));
      }
      return h('svg', {
        className: 'sc_fileIcon',
        width: size,
        height: size,
        viewBox: '0 0 28 28',
        fill: 'none',
        'data-kind': kind,
        'aria-hidden': true,
      }, children);
    }

    /**
     * 统一的列表行：16px 图标（或圆点 / 勾选圆）列 · 弹性文本 · 右侧数值列。
     * 所有区块都走这里，图标尺寸 / 缩进 / 行高 / 数值右对齐只有一处定义，改版式不会再各块各写一套。
     * @param props.iconName 图标名（与 `icon` / `mark` / `check` 四选一）
     * @param props.icon 自带图标的节点（文件类型图标这类多色图标走这里）
     * @param props.mark 圆点语义（running / done / warn / error / idle）
     * @param props.check 勾选圆语义（done / running / idle），与官方任务面板的三态一致
     * @param props.meta 右侧数值节点（数组或单节点）
     * @param props.onClick 给了就是可点行（整行按钮），否则是纯展示行
     */
    function Row({ iconName, icon, mark, check, text, title, meta, action, ariaLabel, onClick }) {
      let lead;
      if (check !== undefined) {
        lead = h('span', { key: 'lead', className: 'sc_check', 'data-state': check },
          check === 'done' ? h(Icon, { key: 'tick', name: 'check', size: 14 }) : null);
      } else if (icon !== undefined) {
        lead = h('span', { key: 'lead', className: 'sc_rowLead' }, icon);
      } else if (iconName === undefined) {
        lead = h('span', { key: 'lead', className: 'sc_rowLead' },
          h('span', { key: 'mark', className: 'sc_mark', 'data-state': mark }));
      } else {
        lead = h('span', { key: 'lead', className: 'sc_rowLead' }, h(Icon, { key: 'icon', name: iconName, size: 14 }));
      }
      const body = [lead, h('span', { key: 'text', className: 'sc_text' }, text)];
      if (meta !== undefined && meta !== null) body.push(h('span', { key: 'meta', className: 'sc_meta' }, meta));
      if (onClick === undefined) return h('div', { className: 'sc_rowInner', title }, body);
      return h('button', {
        type: 'button',
        className: 'sc_rowBtn',
        title,
        'aria-label': ariaLabel,
        'data-sc-action': action,
        onClick,
      }, body);
    }

    /**
     * 分区头：图标 + 加粗标题 + 可选计数 pill + 右侧动作区——五个分区的头只有这一处定义。
     * @param props.icon 图标名（15px）
     * @param props.badge 标题右侧的计数 pill 文本（可缺省）
     * @param props.tail 右对齐的动作 / 数值节点（数组或单节点）
     */
    function SectionHead({ title, badge, tail }) {
      const children = [h('span', { key: 'title', className: 'sc_blockTitle' }, title)];
      if (badge !== undefined && badge !== null) children.push(h('span', { key: 'badge', className: 'sc_countPill' }, badge));
      if (tail !== undefined && tail !== null) children.push(h('span', { key: 'tail', className: 'sc_secTail' }, tail));
      return h('div', { className: 'sc_blockHead' }, children);
    }

    /**
     * 状态条：一行说清本轮的三段时间（模型 / 工具 / 等你）。
     *
     * 这一格早先是「权限 / 沙箱」两个 chip —— 那些信息在 composer 底部与权限选择器里都有，
     * 卡片这里换成只有卡片才给得出的本轮总耗时，一行三段，分隔用淡点。
     */
    function TimingBar({ t, segments }) {
      if (segments.length === 0) return null;
      const [total, ...rest] = segments;
      const parts = [h('span', { key: 'total', className: 'sc_timingTotal' }, [
        h('span', { key: 'name', className: 'sc_timingLabel' }, total.name),
        h('span', { key: 'space', className: 'sc_space' }, ' '),
        h('span', { key: 'value', className: 'sc_timingTotalValue' }, total.value),
      ])];
      rest.forEach((segment, index) => {
        if (index > 0) parts.push(h('span', { key: `dot-${segment.key}`, className: 'sc_timingDot' }, ' · '));
        parts.push(h('span', { key: segment.key, className: 'sc_timingItem' }, [
          h('span', { key: 'name', className: 'sc_timingName' }, segment.name),
          h('span', { key: 'space', className: 'sc_space' }, ' '),
          h('span', { key: 'value', className: 'sc_timingValue' }, segment.value),
        ]));
      });
      return h('div', { className: 'sc_bar', 'data-sc-block': 'timing' }, [
        h('div', { key: 'row', className: 'sc_timing' }, parts),
      ]);
    }

    /**
     * 成员卡：状态圆点 + 两行文本（名称 / 任务与状态）+ 右侧指标（token · 耗时）+ 展开箭头。
     * 与官方 ui-subagent 的目录行同构：点开的入口在右端，状态不再用文字 pill 而是圆点。
     * @param props.metrics 右端指标 `{ tokens, duration }`：两行靠右堆叠，队友没有会话级计量时省略
     * @param props.chevron 是否显示右端箭头（只有能打开的会话才显示，避免误导）
     */
    function AgentRow({ name, line, state, metrics, chevron, onOpen }) {
      const tail = [];
      if (typeof metrics?.tokens === 'string' && metrics.tokens !== '') {
        tail.push(h('span', { key: 'tokens', className: 'sc_metrics' }, metrics.tokens));
      }
      if (typeof metrics?.duration === 'string' && metrics.duration !== '') {
        tail.push(h('span', { key: 'duration', className: 'sc_metricsSub' }, metrics.duration));
      }
      const body = [
        h('span', { key: 'mark', className: 'sc_mark', 'data-state': state }),
        h('span', { key: 'main', className: 'sc_memberMain' }, [
          h('span', { key: 'name', className: 'sc_memberName', title: name }, name),
          typeof line === 'string' && line !== ''
            ? h('span', { key: 'line', className: 'sc_memberDesc', title: line }, line)
            : null,
        ]),
        h('span', { key: 'tail', className: 'sc_memberTail' }, tail),
        chevron === true
          ? h('span', { key: 'chevron', className: 'sc_memberChevron' }, h(Icon, { name: 'chevronRight', size: 12 }))
          : h('span', { key: 'chevron', className: 'sc_memberChevron' }),
      ];
      // 能打开的会话渲染成 button（官方目录行就是整行可点、键盘可达），队友这种拿不到 durable 地址的保持静态。
      if (typeof onOpen === 'function') {
        return h('button', {
          type: 'button',
          className: 'sc_member sc_memberBtn',
          'data-sc-action': 'open-agent',
          title: name,
          'aria-label': name,
          onClick: onOpen,
        }, body);
      }
      return h('div', { className: 'sc_member' }, body);
    }

    /**
     * 任务块：分组头（进度常显）+ 可折叠条目，与官方任务面板的「折叠 / 展开 + 进度」行为一致。
     * @param props.collapsed 条目是否收起（进度仍留在分组头里）
     */
    function TaskBlock({ t, rows, collapsed, onToggleCollapsed, expanded, onToggle }) {
      if (rows.length === 0) return null;
      const progress = taskProgress(rows);
      const shown = expanded ? rows.slice(0, ROW_HARD_CAP) : rows.slice(0, ROW_LIMIT);
      const rest = rows.length - shown.length;
      // 进度百分比：整数取整，total 为 0 时不画进度条（那时块本身也不渲染）。
      const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
      return h('section', { className: 'sc_block', 'data-sc-block': 'task' }, [
        h(SectionHead, {
          key: 'head',
          title: t('task.title'),
          tail: [
            h('span', { key: 'progress', className: 'sc_pill', 'data-tone': 'ok' },
              t('task.progress', { done: progress.done, total: progress.total })),
            h('button', {
              key: 'collapse',
              type: 'button',
              className: 'sc_iconBtn',
              'data-sc-action': 'toggle-task',
              'aria-expanded': !collapsed,
              'aria-label': t(collapsed ? 'list.expand' : 'list.collapse'),
              title: t(collapsed ? 'list.expand' : 'list.collapse'),
              onClick: onToggleCollapsed,
            }, h(Icon, { name: collapsed ? 'chevronRight' : 'chevronDown', size: 14 })),
          ],
        }),
        collapsed ? null : h('div', {
          key: 'progress',
          className: 'sc_progress',
          role: 'progressbar',
          'data-sc-progress': percent,
          'aria-valuenow': percent,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
        }, h('div', { key: 'fill', className: 'sc_progressFill', style: { width: `${percent}%` } })),
        collapsed ? null : h('ul', { key: 'rows', className: 'sc_rows' }, shown.map((row, index) => h('li', {
          key: `task-${index}`,
          className: 'sc_row',
        }, h(Row, {
          check: taskMark(row?.status),
          text: typeof row?.content === 'string' ? row.content : '',
          title: typeof row?.content === 'string' ? row.content : '',
        })))),
        collapsed || rows.length <= ROW_LIMIT ? null : h('button', {
          key: 'more',
          type: 'button',
          className: 'sc_more',
          'aria-expanded': expanded,
          onClick: onToggle,
        }, expanded ? t('task.less') : t('task.more', { total: rows.length })),
        collapsed || !expanded || rest <= 0
          ? null
          : h('div', { key: 'overflow', className: 'sc_note' }, t('list.overflow', { rest })),
      ]);
    }

    /**
     * 目标块：显示 + 卡片内操作（编辑 / 暂停 / 继续 / 清除）。
     *
     * 操作走官方目标条同一条通道（`remote.goals.edit/pause/resume/clear`，参数为 `{id, revision}` CAS 引用），
     * 形态取其简化版：编辑是同条内联 textarea + 保存/取消，其余动作是分组头右侧的图标按钮。
     * `activation`（armed/disarmed）不在客户端投影里，所以按钮只按 phase 出；
     * 落空时把 Host 的错误码连同 message 原样显示（官方目标条也只展示错误）。
     * @param props.actions { edit(ref, objective), pause(ref), resume(ref), clear(ref) }，均返回 Remote 结果对象
     */
    function GoalBlock({ t, goal, actions }) {
      const current = goal?.goal ?? null;
      const currentId = current === null || current === undefined ? null : current.id;
      const ref = goalRef(goal);
      const [editing, setEditing] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [pending, setPending] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [clearedId, setClearedId] = React.useState(null);

      React.useEffect(() => {
        // 清除成功后投影还要晚一拍才消失：清掉的 id 一旦不再出现，就解除乐观隐藏。
        if (clearedId !== null && currentId !== clearedId) setClearedId(null);
      }, [clearedId, currentId]);

      // 串行防重入：同一目标上的两个写操作互斥（官方目标条同样只允许一个在飞）。
      const run = async (task) => {
        if (pending) return false;
        setPending(true);
        setError(null);
        try {
          const result = await task();
          if (result !== null && result !== undefined && result.ok === false) {
            const code = result.error?.code ?? 'unknown';
            const message = typeof result.error?.message === 'string' ? result.error.message : '';
            setError(t('goal.error', { detail: message === '' ? String(code) : `${message} (${code})` }));
            return false;
          }
          return true;
        } catch (failure) {
          setError(t('goal.error', { detail: failure instanceof Error ? failure.message : String(failure) }));
          return false;
        } finally {
          setPending(false);
        }
      };

      if (current === null || current === undefined || typeof current.objective !== 'string') return null;
      if (clearedId !== null && currentId === clearedId) return null;

      const rounds = typeof goal.roundsStarted === 'number' ? goal.roundsStarted : 0;
      const reason = current.blockedReason?.message;
      const available = goalActions(current.phase);
      const canAct = ref !== null && actions !== undefined && actions !== null;

      const startEdit = () => {
        setError(null);
        setDraft(current.objective);
        setEditing(true);
      };
      const cancelEdit = () => {
        setEditing(false);
        setDraft('');
      };
      const save = async () => {
        const objective = draft.trim();
        if (objective === '' || ref === null) return;
        if (await run(() => actions.edit(ref, objective))) cancelEdit();
      };
      const act = (kind) => {
        if (ref === null) return;
        void run(async () => {
          if (kind !== 'clear') return actions[kind](ref);
          const result = await actions.clear(ref);
          if (result === null || result === undefined || result.ok !== false) setClearedId(currentId);
          return result;
        });
      };
      const actionButton = (name, label, onClick) => h('button', {
        key: name,
        type: 'button',
        className: 'sc_iconBtn',
        'data-sc-action': name,
        'aria-label': label,
        title: label,
        disabled: pending || !canAct,
        onClick,
      }, h(Icon, { name, size: 14 }));

      // 没有 CAS 引用（投影缺 id/revision）或目标服务缺席时一律不摆按钮：宁可只读，也不给点不动的入口。
      const buttons = [];
      if (canAct && !editing) {
        if (available.pause) buttons.push(actionButton('pause', t('goal.pause'), () => act('pause')));
        if (available.resume) buttons.push(actionButton('play', t('goal.resume'), () => act('resume')));
        buttons.push(actionButton('edit', t('goal.edit'), startEdit));
        buttons.push(actionButton('trash', t('goal.clear'), () => act('clear')));
      }

      return h('section', { className: 'sc_block', 'data-sc-block': 'goal' }, [
        h(SectionHead, {
          key: 'head',
          title: t('goal.title'),
          tail: [
            h('span', { key: 'phase', className: 'sc_pill', 'data-tone': goalPhaseTone(current.phase) },
              t(goalPhaseKey(goal))),
            h('span', { key: 'round', className: 'sc_blockMeta' }, t('goal.round', { round: rounds })),
            ...buttons,
          ],
        }),
        editing
          ? h('div', { key: 'editor' }, [
            h('textarea', {
              key: 'input',
              className: 'sc_goalEdit',
              value: draft,
              rows: 3,
              'aria-label': t('goal.placeholder'),
              placeholder: t('goal.placeholder'),
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Escape') cancelEdit();
              },
            }),
            h('div', { key: 'actions', className: 'sc_goalActions' }, [
              h('button', {
                key: 'cancel',
                type: 'button',
                className: 'sc_action',
                onClick: cancelEdit,
              }, t('goal.cancel')),
              h('button', {
                key: 'save',
                type: 'button',
                className: 'sc_action',
                'data-sc-action': 'save-goal',
                disabled: pending || draft.trim() === '',
                onClick: () => { void save(); },
              }, t('goal.save')),
            ]),
          ])
          : h('div', { key: 'objective', className: 'sc_goal', title: current.objective }, current.objective),
        typeof reason === 'string' && reason !== ''
          ? h('div', { key: 'reason', className: 'sc_note' }, t('goal.blockedReason', { reason }))
          : null,
        error === null ? null : h('div', { key: 'error', className: 'sc_noteError', role: 'alert' }, error),
      ]);
    }

    /** 计划块：本会话提交过的计划（新的在前），点一行用官方 `plan` 预览类型在右栏打开。 */
    function PlanBlock({ t, rows, expanded, onToggle, onOpenPlan }) {
      if (rows.length === 0) return null;
      const shown = expanded ? rows : rows.slice(0, ROW_LIMIT);
      const rest = rows.length - shown.length;
      return h('section', { className: 'sc_block', 'data-sc-block': 'plan' }, [
        h(SectionHead, {
          key: 'head',
          title: t('plan.title'),
          tail: h('span', { key: 'meta', className: 'sc_blockMeta' }, t('plan.meta', { total: groupDigits(rows.length) })),
        }),
        h('ul', { key: 'rows', className: 'sc_rows' }, shown.map((plan, index) => {
          const title = typeof plan?.title === 'string' && plan.title !== '' ? plan.title : t('plan.untitled');
          // 行首一颗灯泡（提示「这是一条计划」），右侧外链图标表示「在右栏打开官方 plan 预览」。
          return h('li', { key: `plan-${plan?.callId ?? index}`, className: 'sc_row' }, h('button', {
            type: 'button',
            className: 'sc_planRow',
            title,
            'aria-label': t('plan.open', { title }),
            'data-sc-action': 'open-plan',
            onClick: () => onOpenPlan(plan),
          }, [
            h('span', { key: 'icon', className: 'sc_planIcon' }, h(Icon, { key: 'bulb', name: 'bulb', size: 14 })),
            h('span', { key: 'label', className: 'sc_planLabel' }, title),
            h('span', { key: 'open', className: 'sc_planOpen' }, h(Icon, { key: 'external', name: 'external', size: 14 })),
          ]));
        })),
        rows.length <= ROW_LIMIT ? null : h('button', {
          key: 'more',
          type: 'button',
          className: 'sc_more',
          'aria-expanded': expanded,
          onClick: onToggle,
        }, expanded ? t('changes.less') : t('plan.more', { total: groupDigits(rows.length) })),
        expanded && rest > 0
          ? h('div', { key: 'overflow', className: 'sc_note' }, t('list.overflow', { rest }))
          : null,
      ]);
    }

    /** 变更块：整会话按路径去重的文件清单，按「本轮 / 更早」分组，点一行打开官方变更审查。 */
    function ChangesBlock({ t, state, expanded, onToggle, onOpenFile }) {
      if (state.status === 'loading') {
        return h('section', { className: 'sc_block', 'data-sc-block': 'changes' },
          h('div', { className: 'sc_note' }, t('changes.loading')));
      }
      if (state.status === 'failed') {
        return h('section', { className: 'sc_block', 'data-sc-block': 'changes' },
          h('div', { className: 'sc_noteError' }, t('changes.unavailable')));
      }
      const value = state.value;
      const rows = changeRows(value);
      if (rows.length === 0) return null;
      const shown = expanded ? rows : rows.slice(0, ROW_LIMIT);
      const rest = rows.length - shown.length;
      const groups = turnGroups(value, shown);
      const added = typeof value.added === 'number' ? value.added : 0;
      const deleted = typeof value.deleted === 'number' ? value.deleted : 0;
      // 单行：图标 + 路径 + 增删行数；点开的是该文件最后一次改动所在轮次的变更审查。
      const rowOf = (file, index) => h('li', {
        key: `file-${file.seq ?? 0}-${file.index ?? index}`,
        className: 'sc_row',
      }, h(Row, {
        icon: h(FileIcon, { key: 'icon', path: file.path }),
        text: file.display ?? file.path,
        title: file.path,
        ariaLabel: t('changes.open', { path: file.display ?? file.path }),
        onClick: () => onOpenFile(file),
        meta: [
          h('span', { key: 'add', className: 'sc_add sc_num' }, `+${groupDigits(file.added)}`),
          h('span', { key: 'del', className: 'sc_del sc_num' }, `-${groupDigits(file.deleted)}`),
        ],
      }));
      const listOf = (key, list) => h('ul', { key, className: 'sc_rows' }, list.map(rowOf));
      const groupHead = (key, label) => h('div', { key, className: 'sc_group' }, label);
      // 两段并用：本轮回答「这一轮改了什么」，更早回答「整个会话改了什么」；只有一轮时不摆分组头。
      const body = [];
      if (groups === null) {
        body.push(listOf('rows', shown));
      } else {
        body.push(
          groupHead('group-current', t('changes.currentTurn', { total: groupDigits(groups.current.length) })),
          listOf('rows-current', groups.current),
          groupHead('group-earlier', t('changes.earlier', { total: groupDigits(groups.earlier.length) })),
          listOf('rows-earlier', groups.earlier),
        );
      }
      return h('section', { className: 'sc_block', 'data-sc-block': 'changes' }, [
        h(SectionHead, {
          key: 'head',
          title: t('changes.title'),
          tail: [
            h('span', { key: 'meta', className: 'sc_blockMeta' }, t('changes.meta', { total: groupDigits(rows.length) })),
            // 合计比行内数值大一档、加粗（整张卡片最醒目的就是这对增删数字）。
            h('span', { key: 'total', className: 'sc_total', 'data-sc-total': 'changes' }, [
              h('span', { key: 'add', className: 'sc_add sc_num' }, `+${groupDigits(added)}`),
              h('span', { key: 'del', className: 'sc_del sc_num' }, `-${groupDigits(deleted)}`),
            ]),
          ],
        }),
        ...body,
        rows.length <= ROW_LIMIT ? null : h('button', {
          key: 'more',
          type: 'button',
          className: 'sc_more',
          'aria-expanded': expanded,
          onClick: onToggle,
        }, expanded ? t('changes.less') : t('changes.more', { total: groupDigits(rows.length) })),
        expanded && rest > 0
          ? h('div', { key: 'overflow', className: 'sc_note' }, t('list.overflow', { rest }))
          : null,
      ]);
    }

    /** 队友阶段 → 文案（队友没有会话级活动状态，按 agentTeam 的 phase 说）。 */
    function phaseText(t, mark) {
      if (mark === 'error') return t('agents.phase.failed');
      if (mark === 'running') return t('agents.activity.running');
      if (mark === 'warn') return t('agents.phase.provisioning');
      return t('agents.activity.inactive');
    }

    /** 子智能体模式 → 文案（官方 mode.* 四档）。 */
    function modeText(t, mode) {
      if (mode === 'one-shot') return t('agents.mode.oneShot');
      if (mode === 'continuable') return t('agents.mode.continuable');
      if (mode === 'external') return t('agents.mode.external');
      if (typeof mode === 'string' && mode !== '') return t('agents.mode.unknown');
      return null;
    }

    /** 子智能体活动 → 圆点语义。 */
    function subagentMark(row) {
      if (row.running) return 'running';
      if (row.completed) return 'done';
      return 'idle';
    }

    /**
     * 后台任务块：读官方 `ctx.jobs` 的同一份客户端投影（与标题栏那个后台任务面板同源），
     * 只做「看 + 终止」——输出面板留在官方面板里，卡片不再造一个终端。
     *
     * 形状沿用任务块：分区头 + 行表。运行中的行常显（圆点 / 命令 / 进度 / 时长 / 终止），
     * 已结束的折在「已结束 N」后面，点开才铺开——后台任务不该把卡片撑得比计划还长。
     * @param props.jobs `ctx.jobs` 服务（惰性注入，可能暂时缺省）
     * @param props.sessionId 主会话 id
     * @param props.rows 本会话的后台任务行（由卡片主体用 `useJobsRows` 订阅）
     */
    function JobsBlock({ t, sessionId, jobs, rows }) {
      const [settledOpen, setSettledOpen] = React.useState(undefined);
      const [clearedKeys, setClearedKeys] = React.useState(() => new Set());
      const [kill, setKill] = React.useState(null);
      const [now, setNow] = React.useState(() => Date.now());
      const liveRows = rows.filter(jobIsLive);
      // 运行中的时长得自己走：卡片整体不挂定时器，只有这一节在真有活任务时开一秒一跳。
      React.useEffect(() => {
        if (liveRows.length === 0) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [liveRows.length]);
      // 两段确认的节奏照宿主后台任务面板：上膛 3 秒不点就退回，失败提示 4 秒后清掉。
      React.useEffect(() => {
        if (kill === null) return undefined;
        const timer = setTimeout(() => setKill(null), kill.phase === 'armed' ? 3000 : 4000);
        return () => clearTimeout(timer);
      }, [kill]);
      if (jobs === undefined || jobs === null || rows.length === 0) return null;

      const ordered = jobOrder(rows);
      const liveShown = ordered.filter(jobIsLive);
      // 「清空」只清这张卡的表（官方面板同样只在本地把行藏起来，不动宿主那边已结束的记录）。
      const settledRows = ordered.filter((job) => !jobIsLive(job) && !clearedKeys.has(String(job.id)));
      // 没有活任务时默认摊开已结束的：那一屏本来就只有它们。
      const settledExpanded = settledOpen ?? liveShown.length === 0;
      if (liveShown.length + settledRows.length === 0) return null;

      /** 停止：第一下只上膛，第二下才发 `job.kill`；失败则按钮变红，允许再点一次。 */
      const pressStop = (key) => {
        const armed = kill !== null && kill.key === key && kill.phase === 'armed';
        if (!armed) {
          setKill({ key, phase: 'armed' });
          return;
        }
        setKill({ key, phase: 'pending' });
        const settle = (ok) => setKill((current) => (current !== null && current.key === key && current.phase === 'pending'
          ? (ok ? null : { key, phase: 'failed' })
          : current));
        Promise.resolve(jobs.kill(sessionId, key)).then((result) => settle(result?.ok === true)).catch(() => settle(false));
      };

      const clearSettled = () => {
        setClearedKeys((current) => {
          const next = new Set(current);
          for (const job of settledRows) next.add(String(job.id));
          return next;
        });
      };

      /**
       * 一行后台任务，结构与宿主面板同构：
       * 运行中 = 圆点 + （命令 / 类型·进度·时长 两行）+ 方形停止按钮，整行铺一层淡底；
       * 已结束 = 圆点 + 类型 + 命令 + 结算原因 + 时长，整行压成一行弱色。
       */
      const renderJob = (job) => {
        const key = String(job.id);
        const live = jobIsLive(job);
        const label = typeof job.label === 'string' && job.label !== '' ? job.label : String(job.kind ?? '');
        const kind = typeof job.kind === 'string' && job.kind !== '' ? job.kind : null;
        const elapsed = live
          ? now - clockOf(job.startedAt)
          : clockOf(job.finishedAt ?? job.startedAt) - clockOf(job.startedAt);
        const duration = clockOf(elapsed) === 0 ? null : jobDuration(t, elapsed);
        // 与宿主面板同一取舍：运行中优先显示进度（`3/10`），已结束优先显示结算原因（`exit code: 3`）；
        // 都没有才落回状态词——圆点已经说了一遍状态，这一格要放圆点说不出的信息。
        const note = live
          ? (typeof job.progress === 'string' && job.progress !== '' ? job.progress : null)
          : (typeof job.detail === 'string' && job.detail !== '' ? job.detail : t(jobStatusKey(job.status)));
        const durationCell = duration === null ? null : h('span', {
          key: 'duration',
          className: 'sc_jobDuration',
          title: t(live ? 'jobs.duration.live' : 'jobs.duration.done', { duration }),
        }, duration);
        const dot = h('span', { key: 'dot', className: 'sc_mark', 'data-state': jobMark(job.status) });
        const kindPill = kind === null ? null : h('span', { key: 'kind', className: 'sc_jobKind' }, kind);
        if (!live) {
          return h('li', { key: `job-${key}`, className: 'sc_jobLine' }, h('span', {
            className: 'sc_jobRow',
            'data-settled': 'true',
            title: note ?? undefined,
          }, [
            dot,
            kindPill,
            h('span', { key: 'label', className: 'sc_jobLabel', title: label }, label),
            note === null ? null : h('span', { key: 'note', className: 'sc_jobStatus' }, note),
            durationCell,
          ]));
        }
        const phase = kill !== null && kill.key === key ? kill.phase : null;
        const stopTitle = phase === 'armed'
          ? t('jobs.stopConfirm')
          : phase === 'failed' ? t('jobs.stopFailed') : t('jobs.stopTitle', { label });
        return h('li', { key: `job-${key}`, className: 'sc_jobLine', 'data-live': 'true' }, [
          h('span', { key: 'row', className: 'sc_jobRow' }, [
            dot,
            h('span', { key: 'main', className: 'sc_jobMain' }, [
              h('span', { key: 'primary', className: 'sc_jobPrimary' },
                h('span', { key: 'label', className: 'sc_jobLabel', title: label }, label)),
              h('span', {
                key: 'secondary',
                className: 'sc_jobSecondary',
                title: note ?? t(jobStatusKey(job.status)),
              }, [
                kindPill,
                note === null ? null : h('span', { key: 'note', className: 'sc_jobStatus' }, note),
                durationCell,
              ]),
            ]),
          ]),
          h('button', {
            key: 'stop',
            type: 'button',
            className: 'sc_stop',
            'data-sc-action': 'stop-job',
            'data-kill-state': phase ?? 'idle',
            disabled: phase === 'pending',
            title: stopTitle,
            'aria-label': stopTitle,
            onClick: () => pressStop(key),
          }, [
            h(Icon, { key: 'glyph', name: 'stop', size: 10, filled: true }),
            phase === 'armed' ? h('span', { key: 'label', className: 'sc_stopLabel' }, t('jobs.stopAction')) : null,
          ]),
        ]);
      };

      const shownSettled = settledExpanded ? settledRows.slice(0, ROW_HARD_CAP) : [];
      return h('section', { className: 'sc_block', 'data-sc-block': 'jobs' }, [
        h(SectionHead, {
          key: 'head',
          title: t('jobs.title'),
          // 运行中几条用弱色尾巴说（宿主面板的入口也是同一句），不占一颗计数 pill。
          tail: liveShown.length > 0
            ? h('span', { key: 'live', className: 'sc_note' }, t('jobs.badge', { count: liveShown.length }))
            : null,
        }),
        liveShown.length === 0 ? null : h('ul', { key: 'live', className: 'sc_rows' }, liveShown.map(renderJob)),
        // 分组头照宿主面板：左边是折叠开关（箭头闭上指右），右边「清空」。
        settledRows.length === 0 ? null : h('div', { key: 'settled', className: 'sc_jobSection' }, [
          h('button', {
            key: 'toggle',
            type: 'button',
            className: 'sc_jobToggle',
            'data-sc-action': 'toggle-settled-jobs',
            'aria-expanded': settledExpanded,
            onClick: () => setSettledOpen(!settledExpanded),
          }, [
            h('span', { key: 'chevron', className: 'sc_jobChevron', 'data-open': settledExpanded ? 'true' : 'false' },
              h(Icon, { name: 'chevronDown', size: 12 })),
            h('span', { key: 'text' }, t('jobs.settled', { count: settledRows.length })),
          ]),
          h('button', {
            key: 'clear',
            type: 'button',
            className: 'sc_jobClear',
            'data-sc-action': 'clear-settled-jobs',
            onClick: clearSettled,
          }, t('jobs.clear')),
        ]),
        shownSettled.length === 0
          ? null
          : h('ul', { key: 'settledRows', className: 'sc_rows' }, shownSettled.map(renderJob)),
        settledExpanded && settledRows.length > ROW_HARD_CAP
          ? h('div', { key: 'overflow', className: 'sc_note' }, t('list.overflow', { rest: settledRows.length - ROW_HARD_CAP }))
          : null,
      ]);
    }

    /**
     * 子智能体与队友块：与官方子智能体目录行同构的成员卡。
     *
     * 整会话的子会话目录会随委派轮次越攒越多，所以这里按轮次分组：当前轮次直接摊开，
     * 早前的轮次先折成一行（「早前 N 轮 · M 个」），点开才逐轮列出；标题右端的计数始终是总数。
     */
    function AgentsBlock({ t, team, subagents, turns, currentTurn, now, onOpenSubagent }) {
      const [earlierOpen, setEarlierOpen] = React.useState(false);
      const summary = teamSummary(team);
      if (summary === null && subagents.length === 0) return null;
      const groups = agentGroups(subagents, turns, currentTurn);
      // 队友本身就是一条子会话：官方这里只列那条会话行（带 token / 耗时、可点进右栏）。
      // 再补一行「队友 · 正在运行」既重复，又必然是错的——`agentTeam` 的成员 phase 只有
      // provisioning / active / failed 三档，队友跑完仍是 active，会一直转圈（本会话实测）。
      // 只在队友还没有对应会话行时（刚 provisioning）才用成员行兜底。
      const listed = new Set();
      for (const subagent of subagents) listed.add(subagent.key);
      const memberRows = [];
      if (summary !== null) {
        for (const member of summary.teammates) {
          if (typeof member?.id === 'string' && listed.has(member.id)) continue;
          const mark = phaseMark(member?.phase);
          const name = typeof member?.name === 'string' && member.name !== '' ? member.name : t('agents.teammate');
          memberRows.push(h('li', { key: `member-${typeof member?.id === 'string' ? member.id : name}`, className: 'sc_row' }, h(AgentRow, {
            name,
            line: `${t('agents.teammate')} · ${phaseText(t, mark)}`,
            state: mark,
            metrics: null,
            chevron: false,
          })));
        }
      }
      const rowOf = (subagent) => {
        const mark = subagentMark(subagent);
        const activity = mark === 'running'
          ? t('agents.activity.running')
          : subagent.completed ? t('agents.activity.completed') : t('agents.activity.inactive');
        const line = [subagent.title, modeText(t, subagent.mode), activity]
          .filter((piece) => typeof piece === 'string' && piece !== '')
          .join(' · ');
        // token 与耗时分两行靠右放（一行挤在一起时两串数字会连读）。
        const metrics = {
          tokens: formatTokens(t, subagent.tokens),
          duration: formatDuration(t, subagentDuration(subagent, now)),
        };
        return h('li', { key: `sub-${subagent.key}`, className: 'sc_row' }, h(AgentRow, {
          name: subagent.name,
          line,
          state: mark,
          metrics,
          chevron: typeof onOpenSubagent === 'function',
          onOpen: typeof onOpenSubagent === 'function' ? () => onOpenSubagent(subagent) : undefined,
        }));
      };
      // 兜底的队友行没有会话行可用，归属当前轮次（它们刚 provisioning）。
      const currentRows = memberRows.concat(groups.current.map(rowOf));
      // 计数已由标题旁的 pill 承担，这里只在有队友时补一句任务进度，避免「2」与「2 位成员」重复。
      const meta = summary === null
        ? null
        : t('agents.team', { members: summary.teammates.length, done: summary.done, total: summary.total });
      const groupHead = (key, label) => h('div', { key, className: 'sc_group' }, label);
      const listOf = (key, rows) => h('ul', { key, className: 'sc_rows' }, rows);
      const earlierRows = groups.rounds.reduce((sum, round) => sum + round.rows.length, 0);
      const total = currentRows.length + earlierRows;
      const body = [];
      if (groups.rounds.length === 0) {
        // 整轮只有一批子智能体：不摆分组头，跟以前一样干净。
        if (currentRows.length > 0) body.push(listOf('rows-current', currentRows));
      } else {
        if (currentRows.length > 0) {
          body.push(
            groupHead('group-current', t('agents.round.meta', {
              label: t('agents.round.current'),
              count: groupDigits(currentRows.length),
            })),
            listOf('rows-current', currentRows),
          );
        }
        body.push(h('button', {
          key: 'earlier-toggle',
          type: 'button',
          className: 'sc_more',
          'data-sc-action': 'toggle-agent-rounds',
          'aria-expanded': earlierOpen,
          title: earlierOpen ? t('list.collapse') : t('agents.earlier', { rounds: groups.rounds.length, count: groupDigits(earlierRows) }),
          onClick: () => setEarlierOpen((value) => !value),
        }, earlierOpen
          ? t('list.collapse')
          : t('agents.earlier', { rounds: groups.rounds.length, count: groupDigits(earlierRows) })));
        if (earlierOpen) {
          for (const round of groups.rounds) {
            body.push(
              groupHead(`group-${round.turn}`, t('agents.round.n', { round: round.turn })),
              listOf(`rows-${round.turn}`, round.rows.map(rowOf)),
            );
          }
        }
      }
      return h('section', { className: 'sc_block', 'data-sc-block': 'agents' }, [
        h(SectionHead, {
          key: 'head',
          title: t('agents.title'),
          badge: groupDigits(total),
          tail: h('span', { key: 'meta', className: 'sc_blockMeta' }, meta),
        }),
        ...body,
        summary !== null && summary.failure !== null
          ? h('div', { key: 'failure', className: 'sc_noteError' }, summary.failure)
          : null,
      ]);
    }

    // #endregion

    /**
     * 惰性服务槽：`apply` 里的 `ctx.inject(['jobs'])` 可能在卡片已挂载之后才到位，
     * 而普通对象赋值不会触发重渲染——槽把「服务到了」这件事推给已订阅的组件。
     * @returns `{ get, set, subscribe }`，可直接喂 `React.useSyncExternalStore`。
     */
    function createServiceSlot() {
      let value;
      const listeners = new Set();
      return {
        get: () => value,
        set(next) {
          if (value === next) return;
          value = next;
          for (const listener of listeners) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    /**
     * 构造座位组件（闭包持有可选服务槽，用于调用官方右栏与目标通道）。
     * @param services 可选服务槽：`{ sidebarRight?, goals?, jobsSlot? }`，由 apply 里的 ctx.inject 惰性填入。
     * @returns 卡片组件。
     */
    function createStatusCard(services) {
      /**
       * @param props.useSessions 选主会话与投影值
       * @param props.useSessionStatus 读运行状态与各子会话状态
       * @param props.usePanelInfo 读当前中央面板（activePanelId === null 表示正在看会话）
       * @param props.t 本命名空间的翻译函数
       */
      return function StatusCard({ useSessions, useSessionStatus, usePanelInfo, t }) {
        // 无条件调用（hooks 规则）：宿主没给 usePanelInfo 时退化为「当作在看会话」。
        const usePanel = typeof usePanelInfo === 'function' ? usePanelInfo : ALWAYS_CONVERSATION;
        const conversationActive = usePanel(selectConversationPanel);
        const sessionId = useMainSessionId(useSessions);
        const cwd = useSessions((snapshot) => (sessionId === undefined ? undefined : snapshot.byId[sessionId]?.cwd));
        // 副标题优先用 durable 会话标题（真实信息），没有才回退到固定文案。
        const sessionTitle = useSessions((snapshot) => (sessionId === undefined ? undefined : snapshot.byId[sessionId]?.title));
        const todos = useSessionValue(useSessions, sessionId, 'todos');
        const goal = useSessionValue(useSessions, sessionId, 'goal');
        const team = useSessionValue(useSessions, sessionId, 'agentTeam');
        const running = useSessionStatus((snapshot) => (sessionId === undefined ? undefined : snapshot.get(sessionId)?.running));
        const statuses = useSessionStatus((snapshot) => snapshot);
        const subagents = useSessions((snapshot) => subagentRows(snapshot, sessionId, statuses), equalRows);
        // 后台任务：服务本身走惰性槽（没装 job controller 时恒为 undefined，这一节整块不出现），
        // 行表交给 `useJobsRows` 订阅官方 model——与标题栏那个后台任务面板同源。
        const jobsSlot = services.jobsSlot;
        const jobs = useServiceValue(jobsSlot);
        const jobRows = useJobsRows(jobs, sessionId);
        // 渲染时刻用作「现在」：运行中的活跃耗时按这一瞬算，随下次渲染前移。
        const now = Date.now();
        // 主题（高亮色）：跟卡片同一份模块级状态，`data-sc-theme` 落到卡片根上，
        // 换色只改 CSS 变量，不重排任何结构。
        const theme = useTheme();

        const anchorRef = React.useRef(null);
        const [revision, refresh] = useTurnRevision(running);
        const changes = useChanges(sessionId, revision, running);
        const content = useContentElement(sessionId);
        const anchor = useAnchor(anchorRef, content);
        const geometry = anchor.geometry;
        // 双闸门：① 不在会话页（在看插件 / 定时任务等全局面板）时不渲染；
        // ② 空间不足时不渲染——量得到正文列宽度时用推让模型（推不动就收起，收回圆钮），
        //    量不到就退回老的 820px 保险丝（绝不拿猜的数字去推宿主布局）。
        // 两种都只收掉卡片本体，锚点元素必须留着——它一旦消失，offsetParent 就测不到，
        // 宽度会读回 null，卡片又会冒出来来回抖。折叠态一并遵守：没有归属或空间不足，
        // 就不该有任何形态压在别人的界面上。
        const roomForCard = anchor.contentWidth === null
          || (anchor.chatWidth === null
            ? anchor.contentWidth >= HIDE_BELOW_CONTENT_WIDTH
            : anchor.contentWidth >= MIN_CONTENT_WIDTH);
        const cardVisible = conversationActive && roomForCard;
        const layout = useCardLayout({
          content,
          contentWidth: anchor.contentWidth,
          chatWidth: anchor.chatWidth,
        });
        const collapsed = layout.collapsed;
        const setCollapsed = layout.setCollapsed;
        const [tasksCollapsed, setTasksCollapsed] = React.useState(false);
        const [tasksExpanded, setTasksExpanded] = React.useState(false);
        const [plansExpanded, setPlansExpanded] = React.useState(false);
        const [filesExpanded, setFilesExpanded] = React.useState(false);
        useHideOfficialTodoDock(sessionId, content, cardVisible);

        const taskRowList = taskRows(todos);
        const planRowList = planRows(changes.value);
        const fileRows = changeRows(changes.value);
        const teamInfo = teamSummary(team);
        // 状态条是本卡片的常驻信息（本轮耗时），只要这一轮有记录就不算空。
        const timingRowList = timingSegments(t, changes.value, now);
        const hasContent = timingRowList.length > 0
          || taskRowList.length > 0
          || (goal?.goal !== undefined && goal?.goal !== null)
          || planRowList.length > 0
          || fileRows.length > 0
          || subagents.length > 0
          || jobRows.length > 0
          || teamInfo !== null;
        // 常驻定位：只要有主会话就渲染卡片；无内容时由 body 显示空态，
        // 而不是整卡 return null（否则干净会话里卡片根本不挂载、看不到任何状态）。
        if (sessionId === undefined) return null;

        /** 右栏打开：优先 `openResourceIn`（浮层里没有「屏上会话」，地址自带会话更稳），否则退回官方门面。 */
        const openResource = (address) => {
          const sidebar = services?.sidebarRight;
          if (sidebar === undefined || sidebar === null) return;
          if (typeof sidebar.openResourceIn === 'function') {
            sidebar.openResourceIn(sessionId, address);
            return;
          }
          sidebar.openResource?.(address);
        };

        const openFile = (file) => {
          if (typeof file.seq !== 'number' || typeof file.turn !== 'number' || typeof file.index !== 'number') return;
          const sidebar = services?.sidebarRight;
          if (sidebar === undefined || sidebar === null) return;
          const address = reviewAddress(sessionId, file.seq, file.turn);
          if (typeof sidebar.openResourceIn === 'function') sidebar.openResourceIn(sessionId, address, { params: { index: file.index } });
          else sidebar.openResource?.(address, { params: { index: file.index } });
        };

        /**
         * 打开子智能体的会话：官方目录行走的是 `uiWorkspace.openSession(durable 子会话地址)`，
         * 这里照抄同一条通道 —— `sidebarRight` 只管右侧标签页，切整个工作区会话得用 uiWorkspace。
         */
        const openSubagent = (subagent) => {
          if (typeof subagent?.key !== 'string' || subagent.key === '') return;
          const workspace = services?.uiWorkspace;
          if (workspace === undefined || workspace === null) return;
          if (typeof workspace.openSession !== 'function') return;
          const mode = subagent.mode === 'one-shot' || subagent.mode === 'continuable' ? subagent.mode : 'unknown';
          workspace.openSession({ parentSessionId: sessionId, childSessionId: subagent.key, mode });
        };

        const openPlan = (plan) => {
          if (typeof plan.callId !== 'string' || plan.callId === '') return;
          // 子会话的计划要用官方的五段地址，否则右栏不认（主会话这里是 undefined）。
          const child = services?.sessions?.subagentAddress?.(sessionId);
          openResource(planAddress(sessionId, plan.callId, child));
        };

        // 目标操作：服务缺席时返回一个「不可用」结果，交给 GoalBlock 统一呈现，绝不抛。
        const callGoals = (task) => {
          const goals = services?.goals;
          const unavailable = { ok: false, error: { code: 'goal-unavailable', message: t('goal.unavailable') } };
          if (goals === undefined || goals === null) return Promise.resolve(unavailable);
          try {
            return Promise.resolve(task(goals));
          } catch (failure) {
            return Promise.reject(failure);
          }
        };
        // 服务缺席时整个 API 不存在：GoalBlock 据此退化为只读，不摆「点了也只会失败」的按钮。
        const goalActionsApi = services?.goals === undefined || services?.goals === null ? undefined : {
          edit: (ref, objective) => callGoals((goals) => goals.edit(sessionId, ref, { objective })),
          pause: (ref) => callGoals((goals) => goals.pause(sessionId, ref)),
          resume: (ref) => callGoals((goals) => goals.resume(sessionId, ref)),
          clear: (ref) => callGoals((goals) => goals.clear(sessionId, ref)),
        };

        const title = basename(cwd) ?? t('card.title');
        const subtitle = typeof sessionTitle === 'string' && sessionTitle !== '' ? sessionTitle : t('card.subtitle');
        const refreshButton = h('button', {
          key: 'refresh',
          type: 'button',
          className: 'sc_square',
          'data-sc-action': 'refresh',
          'aria-label': t('card.refresh'),
          title: t('card.refresh'),
          onClick: refresh,
        }, h(Icon, { name: 'refresh', size: 16 }));

        const toggleButton = h('button', {
          key: 'toggle',
          type: 'button',
          className: 'sc_square',
          'data-sc-action': 'toggle-card',
          'aria-expanded': true,
          'aria-label': t('card.collapse'),
          title: t('card.collapse'),
          onClick: () => setCollapsed(true),
        }, h(Icon, { name: 'chevronDown', size: 16 }));

        // 折叠形态：整张卡片换成一颗圆形按钮（跟宿主「回到底部」那颗同款），点它展开。
        const fab = h('button', {
          key: 'fab',
          type: 'button',
          className: 'sc_fab',
          'data-sc-action': 'toggle-card',
          'aria-expanded': false,
          'aria-label': t('card.expand'),
          title: t('card.expand'),
          onClick: () => setCollapsed(false),
        }, h(Icon, { name: 'chevronLeft', size: 16 }));

        return h('div', {
          ref: anchorRef,
          className: 'sc_anchor',
          'data-anchored': geometry === null ? 'false' : 'true',
          'data-card-visible': cardVisible ? 'true' : 'false',
          // 形态开关：'card' 展开 / 'fab' 收起。CSS 按它给两侧播伸缩过渡（卡片常驻、不卸载）。
          'data-state': collapsed ? 'fab' : 'card',
          style: geometry === null ? FALLBACK_ANCHOR : geometry,
        }, cardVisible ? [h('aside', {
          className: 'sc_card',
          'data-plugin': 'dsh-status-card',
          // 主题预设 id：CSS 里 `.sc_card[data-sc-theme=x]` 把 `--sc-theme` 换成对应色阶。
          'data-sc-theme': theme,
          // 收起后卡片还在 DOM 里（要播完那段收缩），由 CSS 隐藏并移出无障碍树。
          'aria-hidden': collapsed ? 'true' : undefined,
          'aria-label': t('card.title'),
        }, [
          h('div', { key: 'head', className: 'sc_head' }, [
            h('div', { key: 'text', className: 'sc_headText' }, [
              h('span', { key: 'title', className: 'sc_title', title: cwd ?? title }, title),
              subtitle === '' ? null : h('span', { key: 'subtitle', className: 'sc_subtitle' }, subtitle),
            ]),
            refreshButton,
            toggleButton,
          ]),
          // 分区顺序：状态条 → 计划 → 目标 → 任务 → 变更 → 子智能体 → 后台任务。
          h('div', { key: 'body', className: 'sc_body' }, hasContent ? [
            h(TimingBar, { key: 'timing', t, segments: timingRowList }),
            h(PlanBlock, {
              key: 'plan',
              t,
              rows: planRowList,
              expanded: plansExpanded,
              onToggle: () => setPlansExpanded((value) => !value),
              onOpenPlan: openPlan,
            }),
            h(GoalBlock, { key: 'goal', t, goal, actions: goalActionsApi }),
            h(TaskBlock, {
              key: 'task',
              t,
              rows: taskRowList,
              collapsed: tasksCollapsed,
              onToggleCollapsed: () => setTasksCollapsed((value) => !value),
              expanded: tasksExpanded,
              onToggle: () => setTasksExpanded((value) => !value),
            }),
            h(ChangesBlock, {
              key: 'changes',
              t,
              state: changes,
              expanded: filesExpanded,
              onToggle: () => setFilesExpanded((value) => !value),
              onOpenFile: openFile,
            }),
            // `now` 只用于算运行中子智能体的活跃耗时（卡片不挂定时器，跟渲染时机刷新）；
            // `turns` / `currentTurn` 用来把子智能体按委派轮次分组（早前轮次折叠）。
            h(AgentsBlock, {
              key: 'agents',
              t,
              team,
              subagents,
              turns: changes?.value?.subagentTurns ?? null,
              currentTurn: changes?.value?.timing?.turn ?? null,
              now,
              onOpenSubagent: openSubagent,
            }),
            // 后台任务排在子智能体之后：与宿主「后台任务」面板的位置一致，也符合「先人后机器」的阅读顺序。
            h(JobsBlock, { key: 'jobs', t, sessionId, jobs, rows: jobRows }),
          ] : h('div', { key: 'empty', className: 'sc_note' }, t('card.empty'))),
        ]), fab] : null);
      };
    }

    /**
     * 插件详情页里的「高亮色」设置块（座位 `plugins.bundle.config`）。
     *
     * 只认 `view === 'page'`：同一个座位在 bundle 列表的摘要视图（view='summary'）也会被调用，
     * 那里是插件行，不该塞一排色点。owner 传进来的 `form` 是 Host 配置表单，本插件没有
     * Host Config，主题只活在客户端，所以不接 `form`（签名里也不解构它）。
     */
    function ThemeSettings({ view, t }) {
      if (view === 'summary') return null;
      const theme = useTheme();
      return h('div', { className: 'sc_theme', 'data-plugin': 'dsh-status-card' },
        h('div', { className: 'sc_themeHead' },
          h('span', { className: 'sc_themeTitle' }, t('theme.title')),
          h('span', { className: 'sc_themeHint' }, t('theme.hint'))),
        h('div', { className: 'sc_themeRow', role: 'group', 'aria-label': t('theme.title') },
          THEMES.map((preset) => h('button', {
            key: preset.id,
            type: 'button',
            className: 'sc_themeChip',
            'data-sc-theme': preset.id,
            'aria-pressed': theme === preset.id ? 'true' : 'false',
            // 选中态除了底色还有色点外圈的实心环，不依赖颜色深浅即可辨认。
            'aria-label': theme === preset.id ? `${t(preset.label)} · ${t('theme.selected')}` : t(preset.label),
            title: t(preset.label),
            onClick: () => setTheme(preset.id),
          },
          h('span', { key: 'dot', className: 'sc_themeDot', 'aria-hidden': 'true' }),
          h('span', { key: 'label' }, t(preset.label))))));
    }

    // #endregion

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        /**
         * 可选服务槽：右栏（打开计划/变更预览）与目标操作都属「有则用、无则降级」。
         *
         * 故意**不**写进插件 inject：cordis 的数组 inject 全是必需项（无 optional 形式），
         * 缺任一服务整张卡片会永久停在 PENDING —— 一个纯展示卡片不该因为目标服务缺席而消失。
         * `ctx.inject(deps, cb)` 会在依赖到齐时启动子 fiber，缺席时静默不执行。
         */
        const services = {
          sidebarRight: undefined,
          goals: undefined,
          sessions: ctx.sessions,
          uiWorkspace: undefined,
          // 后台任务服务走「槽」而不是普通字段：服务可能在卡片挂载后才到位，
          // 普通赋值不会触发重渲染，槽会通知已订阅的组件。
          jobsSlot: createServiceSlot(),
        };

        ctx.inject(['sidebarRight'], (scope) => {
          services.sidebarRight = scope.sidebarRight;
        });

        ctx.inject(['jobs'], (scope) => {
          services.jobsSlot.set(scope.jobs);
        });

        ctx.inject(['remote', 'remote.goals'], (scope) => {
          services.goals = scope.remote.goals;
        });

        ctx.inject(['uiWorkspace'], (scope) => {
          services.uiWorkspace = scope.uiWorkspace;
        });

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'status-card: dictionaries');
        ctx.effect(() => injectStyles(), 'status-card: styles');
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'status-card',
          order: 50,
          locale: NS,
        }, createStatusCard(services)));

        /**
         * 设置块挂在「插件详情」的配置座位，key 用本包名：宿主只渲染登记过这个 key 的
         * bundle（`ledger.bundles.has(pkg.name)`，读的是 client 座位台账），所以这里注册
         * 之后，插件市场 → 本包详情页就会多出一段「高亮色」。不需要 Host 导出 Config。
         */
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE_NAME,
          locale: NS,
        }, ThemeSettings)), 'status-card: theme settings slot');
      },
    };
  },
});
