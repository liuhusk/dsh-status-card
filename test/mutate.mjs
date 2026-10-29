/**
 * 变异测试：证明 smoke.mjs 的断言不是「恒真」。
 * 每一条变异都写在系统临时目录下的 client.js 副本里（绝不改工作区源文件），
 * 然后跑冒烟脚本，检查预期的用例确实 FAIL 且退出码非 0。
 *
 * @author liuh
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REAL = fileURLToPath(new URL('../client.js', import.meta.url));
const SMOKE = fileURLToPath(new URL('./smoke.mjs', import.meta.url));
const SRC = readFileSync(REAL, 'utf8');
const DIR = mkdtempSync(path.join(tmpdir(), 'sc-mutants-'));

const MUTATIONS = [
  {
    name: 'M1 卡片底色改回 bg-overlay',
    from: 'background:var(--dsw-alias-bg-base)',
    to: 'background:var(--dsw-alias-bg-overlay)',
    expectFail: ['A2', 'A3'],
  },
  {
    name: 'M2 删掉隐藏官方任务面板的规则',
    from: "'[data-conversation-content][data-status-card-hide-todo] [data-testid=\"todo-panel\"]{display:none!important}',",
    to: '',
    expectFail: ['A4'],
  },
  {
    name: 'M3 耗时数值丢掉自己的样式类（三段挤成一团看不出强弱）',
    from: "h('span', { key: 'value', className: 'sc_timingValue' }, segment.value),",
    to: "h('span', { key: 'value', className: 'sc_timingName' }, segment.value),",
    expectFail: ['B8'],
  },
  {
    name: 'M4 无 sessionId 也渲染卡片',
    from: 'if (sessionId === undefined) return null;',
    to: 'if (sessionId === undefined && false) return null;',
    expectFail: ['B5'],
  },
  {
    name: 'M5 折叠阈值 6 → 20（9 项不再溢出）',
    from: 'const ROW_LIMIT = 6;',
    to: 'const ROW_LIMIT = 20;',
    expectFail: ['B14'],
  },
  {
    name: 'M6 有耗时也算空（hasContent 恒 false）',
    from: 'const hasContent = timingRowList.length > 0',
    to: 'const hasContent = false',
    expectFail: ['B7'],
  },
  {
    name: 'M7 空态文案改掉（证明词典确实被读取）',
    from: "'card.empty': '暂无任务与变更',",
    to: "'card.empty': '暂无内容',",
    expectFail: ['B6'],
  },
  {
    name: 'M8 引入官方 primitives 依赖',
    from: "    const React = require('react');",
    to: "    const React = require('react');\n    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');",
    expectFail: ['B19'],
  },
  {
    name: 'M9 任务圆点状态全部退化为 idle',
    from: '      if (status === \'completed\') return \'done\';\n      if (status === \'in_progress\') return \'running\';',
    to: '      if (status === \'completed\') return \'idle\';\n      if (status === \'in_progress\') return \'idle\';',
    expectFail: ['B18'],
  },
  {
    name: 'M10 变更路由地址写错',
    from: 'const CHANGES_ROUTE = \'api/status-card.changes\';',
    to: 'const CHANGES_ROUTE = \'/api/status-card/changes\';',
    expectFail: ['X3'],
  },
  {
    name: 'M11 变更失败态文案改掉',
    from: "'changes.unavailable': '变更数据不可用',",
    to: "'changes.unavailable': '失败',",
    expectFail: ['B15'],
  },
  {
    name: 'M12 载入态文案改掉',
    from: "'changes.loading': '读取变更…',",
    to: "'changes.loading': '加载中',",
    expectFail: ['B16'],
  },
  {
    name: 'M13 任务进度文案改掉',
    from: "'task.progress': '{done}/{total} 已完成',",
    to: "'task.progress': '{done}/{total}',",
    expectFail: ['B9'],
  },
  {
    name: 'M14 队友汇总文案改掉',
    from: "'agents.team': '队友 {members} · 任务 {done}/{total}',",
    to: "'agents.team': '队友 {members}',",
    expectFail: ['B11'],
  },
  {
    name: 'M15 目标轮次文案改掉',
    from: "'goal.round': '第 {round} 轮',",
    to: "'goal.round': 'round {round}',",
    expectFail: ['B12'],
  },
  {
    name: 'M16 千分位分组失效',
    from: '.replace(/\\B(?=(\\d{3})+(?!\\d))/g, \',\')',
    to: '.replace(/\\B(?=(\\d{3})+(?!\\d))/g, \'\')',
    expectFail: ['B10'],
  },
  {
    name: 'M17 路由里的 timing 不再被读到（状态条永远缺数据）',
    from: 'const timingRowList = timingSegments(t, changes.value, now);',
    to: 'const timingRowList = timingSegments(t, null, now);',
    expectFail: ['B7', 'B8', 'F13', 'F14'],
  },
  {
    name: 'M18 圆钮 aria-label 也写成「收起卡片」',
    from: "'aria-label': t('card.expand'),",
    to: "'aria-label': t('card.collapse'),",
    expectFail: ['B13', 'B17'],
  },
  {
    name: 'M19 收起时不切形态开关（卡片不缩、圆钮不接管）',
    from: "'data-state': collapsed ? 'fab' : 'card',",
    to: "'data-state': 'card',",
    expectFail: ['B13', 'B17', 'C6', 'F9'],
  },
  {
    name: 'M20 座位注册的 locale 命名空间写错',
    from: 'locale: NS,',
    to: "locale: 'other',",
    expectFail: ['X1'],
  },
  {
    name: 'M21 图标改用官方图标组件（非自绘 svg）',
    from: "    function Icon({ name, size = 14, filled = false }) {\n      const paths = ICON_PATHS[name] ?? ICON_PATHS.dot;",
    to: "    function Icon({ name, size = 14, filled = false }) {\n      if (name === 'refresh') return h('span', { className: 'officialIcon' });\n      const paths = ICON_PATHS[name] ?? ICON_PATHS.dot;",
    expectFail: ['B19'],
  },
  {
    name: 'M22 styles 不再回收',
    from: '        if (tag.isConnected) tag.remove();',
    to: '        void tag;',
    expectFail: ['X4'],
  },
  // ---- 第二轮（空间闸门）新增：每一条都要求「驱动测量」这条路径真的跑起来才能抓住 ----
  {
    name: 'M23 边界差一：>= 改成 >（820 会被误判为放不下）',
    from: 'anchor.contentWidth >= HIDE_BELOW_CONTENT_WIDTH',
    to: 'anchor.contentWidth > HIDE_BELOW_CONTENT_WIDTH',
    expectFail: ['C3'],
  },
  {
    name: 'M24 闸门失效：cardVisible 恒为 true',
    // 锚点只取单行前缀：cardVisible 现在跨两行书写，整行锚点会失配（锚点找不到会被判为 FAIL）。
    from: 'const cardVisible = conversationActive',
    to: 'const cardVisible = true || conversationActive',
    expectFail: ['C2', 'C3', 'C4', 'C6', 'C7'],
  },
  {
    name: 'M25 锚点容器跟着卡片一起消失（整体 return null）',
    from: "        return h('div', {\n          ref: anchorRef,",
    to: "        if (!cardVisible) return null;\n        return h('div', {\n          ref: anchorRef,",
    expectFail: ['C2', 'C6', 'C7'],
  },
  {
    name: 'M26 调用 useHideOfficialTodoDock 时丢掉第三个参数（标记不再联动）',
    from: 'useHideOfficialTodoDock(sessionId, content, cardVisible);',
    to: 'useHideOfficialTodoDock(sessionId, content);',
    expectFail: ['C7'],
  },
  {
    name: 'M27 宽度未知当作没空间（测量失败 → 卡片永久消失）',
    from: 'const roomForCard = anchor.contentWidth === null',
    to: 'const roomForCard = anchor.contentWidth !== null',
    expectFail: ['C5a', 'C5b', 'C5c'],
  },
  {
    name: 'M28 去掉「宽/高为 0 视为测量失败」的判断',
    from: 'if (layer === null || contentRect === null || contentRect.width === 0 || contentRect.height === 0) {',
    to: 'if (layer === null || contentRect === null) {',
    expectFail: ['C5b', 'C5c'],
  },
  {
    name: 'M29 contentWidth 不取整（丢掉 Math.round）',
    from: 'const contentWidth = Math.round(contentRect.width);',
    to: 'const contentWidth = contentRect.width;',
    expectFail: ['C3'],
  },
  {
    name: 'M30 锚点根 data-card-visible 恒为 true',
    from: "'data-card-visible': cardVisible ? 'true' : 'false',",
    to: "'data-card-visible': 'true',",
    expectFail: ['C2', 'C3'],
  },
  {
    name: 'M31 锚点容器丢掉定位规则（.sc_anchor 规则被删）',
    from: "'.sc_anchor{z-index:1;pointer-events:none;position:absolute}',",
    to: '',
    expectFail: ['C8'],
  },
  // ---- 第三轮（面板闸门）新增：看全局面板时不该渲染 ----
  {
    name: 'M32 面板闸门失效：conversationActive 恒 true（插件页也渲染卡片）',
    from: 'const conversationActive = usePanel(selectConversationPanel);',
    to: 'const conversationActive = true;',
    expectFail: ['C9', 'C10', 'C12'],
  },
  {
    name: 'M33 面板闸门覆盖宽度闸门：cardVisible 忽略内容区宽度',
    from: 'const cardVisible = conversationActive && roomForCard;',
    to: 'const cardVisible = conversationActive;',
    expectFail: ['C2', 'C3', 'C4', 'C12'],
  },
  // ---- 第四轮（目标操作 / 计划预览 / 任务折叠）新增 ----
  {
    name: 'M35 计划地址前缀缺尾斜杠（拼出的地址不是合法 plan 地址）',
    from: "const PLAN_PREFIX = 'dsh-resource://plan/';",
    to: "const PLAN_PREFIX = 'dsh-resource://plan';",
    expectFail: ['P2'],
  },
  {
    name: 'M36 计划行不按 seq 倒序（新的排在后面）',
    from: 'for (let index = plans.length - 1; index >= 0; index -= 1) {',
    to: 'for (let index = 0; index < plans.length; index += 1) {',
    expectFail: ['P3'],
  },
  {
    name: 'M37 目标 CAS 引用丢掉 revision（并发时会被 Host 判 STALE）',
    from: 'return { id: current.id, revision: current.revision };',
    to: 'return { id: current.id };',
    expectFail: ['O3'],
  },
  {
    name: 'M38 清除成功后不乐观隐藏（投影追平前闪回旧目标）',
    from: 'if (result === null || result === undefined || result.ok !== false) setClearedId(currentId);',
    to: '',
    expectFail: ['O7'],
  },
  {
    name: 'M39 目标服务缺席也摆按钮（点了只会收到 goal-unavailable）',
    from: 'const goalActionsApi = services?.goals === undefined || services?.goals === null ? undefined : {',
    to: 'const goalActionsApi = false ? undefined : {',
    expectFail: ['O8'],
  },
  {
    name: 'M40 任务块忽略折叠态（收起后条目照旧渲染）',
    from: "collapsed ? null : h('ul', { key: 'rows', className: 'sc_rows' }, shown.map((row, index) => h('li', {",
    to: "false ? null : h('ul', { key: 'rows', className: 'sc_rows' }, shown.map((row, index) => h('li', {",
    expectFail: ['G1'],
  },
  // ---- 第五轮（变更块按轮次分组）新增 ----
  {
    name: 'M42 变更块永不分组（丢掉「本轮 / 更早」分段）',
    from: "      if (typeof lastTurn !== 'number') return null;",
    to: "      if (typeof lastTurn !== 'number' || true) return null;",
    expectFail: ['E2', 'E3'],
  },
  {
    name: 'M43 分组把「本轮」判反（本轮行落进更早一段）',
    from: 'const current = rows.filter((file) => file.turn === lastTurn);',
    to: 'const current = rows.filter((file) => file.turn !== lastTurn);',
    expectFail: ['E2', 'E3'],
  },
  {
    name: 'M44 卡片窄回 280px（回到拥挤版式）',
    from: 'width:372px;',
    to: 'width:280px;',
    expectFail: ['F1'],
  },
  {
    name: 'M45 删掉首段不画线的覆盖（首段多一条悬空分隔线）',
    from: "      '.sc_block:first-of-type{border-top:none;margin-top:0;padding-top:4px}',\n",
    to: '',
    expectFail: ['F2'],
  },
  {
    name: 'M46 合计数字去掉加粗（增删不再高亮）',
    from: "font-size:13px;font-weight:600;min-width:52px",
    to: "font-size:13px;font-weight:400;min-width:52px",
    expectFail: ['F4'],
  },
  {
    name: 'M47 增删数字退回 alpha 底色 token（数字变透明）',
    from: "color:var(--dsw-alias-file-diff-added-marker);min-width:46px",
    to: "color:var(--dsw-alias-code-diff-added);min-width:46px",
    expectFail: ['F5'],
  },
  {
    name: 'M48 三列网格退化成 auto 列（图标列不再对齐）',
    from: 'grid-template-columns:16px minmax(0,1fr) auto',
    to: 'grid-template-columns:auto minmax(0,1fr) auto',
    expectFail: ['F7'],
  },
  {
    name: 'M49 区块标签退回几乎看不见的 caption 档',
    from: "'.sc_blockTitle{color:var(--sc-fg-strong);",
    to: "'.sc_blockTitle{color:var(--dsw-alias-label-caption);",
    expectFail: ['F6'],
  },
  {
    name: 'M50 图标尺寸从 14px 放大到 16px（各块不再统一）',
    from: "'.sc_icon{flex:none;width:14px;height:14px;",
    to: "'.sc_icon{flex:none;width:16px;height:16px;",
    expectFail: ['F8'],
  },
  {
    name: 'M41 编辑目标时不 trim 草稿（空白目标会被提交）',
    from: 'const objective = draft.trim();',
    to: 'const objective = draft;',
    // O5 的禁用按钮走的是另一处 `draft.trim() === ''`，所以只影响 O4（提交值带空白）。
    expectFail: ['O4'],
  },
  {
    name: 'M34 兜底恒为「不在会话」：宿主缺 usePanelInfo 时卡片消失',
    from: 'const ALWAYS_CONVERSATION = () => true;',
    to: 'const ALWAYS_CONVERSATION = () => false;',
    expectFail: ['C11'],
  },
  // ---- 第六轮（按参考图重排版式）新增 ----
  {
    name: 'M51 进度条漏乘 100（完成率当像素用）',
    from: 'const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);',
    to: 'const percent = progress.done;',
    expectFail: ['F10'],
  },
  {
    name: 'M52 勾选圆把进行中也画成已完成',
    from: "      if (status === 'in_progress') return 'running';",
    to: "      if (status === 'in_progress') return 'done';",
    expectFail: ['F10', 'B18'],
  },
  {
    name: 'M53 顶栏副标题丢掉会话标题（恒用固定文案）',
    from: "const subtitle = typeof sessionTitle === 'string' && sessionTitle !== '' ? sessionTitle : t('card.subtitle');",
    to: "const subtitle = t('card.subtitle');",
    expectFail: ['F9'],
  },
  {
    name: 'M54 计划行退回普通列表行（丢掉整行高亮卡）',
    from: "            className: 'sc_planRow',",
    to: "            className: 'sc_rowBtn',",
    expectFail: ['F11'],
  },
  {
    name: 'M55 状态条第一段前面也插分隔点（悬挂分隔）',
    from: 'if (index > 0) parts.push(',
    to: 'if (index >= 0) parts.push(',
    expectFail: ['F13'],
  },
  {
    name: 'M56 子智能体主行丢掉 spawn label（退回会话 displayTitle）',
    from: 'name: label ?? durableTitle ?? displayTitle ?? String(row.id),',
    to: 'name: displayTitle ?? durableTitle ?? String(row.id),',
    expectFail: ['F12'],
  },
  {
    name: 'M57 头部圆形按钮退回方角',
    from: 'background:var(--dsw-alias-bg-base);border:1px solid var(--sc-line);border-radius:999px;',
    to: 'background:var(--dsw-alias-bg-base);border:1px solid var(--sc-line);border-radius:var(--dsw-radius-sm);',
    expectFail: ['F9'],
  },
  {
    name: 'M58 状态条退回额外左右缩进',
    from: "'.sc_bar{margin:2px 0 8px;display:flex}',",
    to: "'.sc_bar{margin:2px var(--sc-pad) 8px;display:flex}',",
    expectFail: ['F13'],
  },
  {
    name: 'M59 折叠态按钮换成横条式的方钮',
    from: "className: 'sc_fab',",
    to: "className: 'sc_square',",
    expectFail: ['B13', 'C6', 'F9'],
  },
  {
    name: 'M60 目标块又排回任务下面',
    from: "            h(GoalBlock, { key: 'goal', t, goal, actions: goalActionsApi }),\n            h(TaskBlock, {\n              key: 'task',\n              t,\n              rows: taskRowList,\n              collapsed: tasksCollapsed,\n              onToggleCollapsed: () => setTasksCollapsed((value) => !value),\n              expanded: tasksExpanded,\n              onToggle: () => setTasksExpanded((value) => !value),\n            }),\n",
    to: "            h(TaskBlock, {\n              key: 'task',\n              t,\n              rows: taskRowList,\n              collapsed: tasksCollapsed,\n              onToggleCollapsed: () => setTasksCollapsed((value) => !value),\n              expanded: tasksExpanded,\n              onToggle: () => setTasksExpanded((value) => !value),\n            }),\n            h(GoalBlock, { key: 'goal', t, goal, actions: goalActionsApi }),\n",
    expectFail: ['F14'],
  },
  {
    name: 'M62 卡片去掉伸缩过渡（只剩硬切）',
    from: 'transform-origin:calc(100% - 27px) 29px;transition:opacity 170ms ease,transform 220ms cubic-bezier(.34,1.4,.64,1),visibility 0s;width:372px;',
    to: 'transform-origin:calc(100% - 27px) 29px;width:372px;',
    expectFail: ['F9'],
  },
  {
    name: 'M63 圆钮缩回卡片角落（与收起按钮不同心）',
    from: '.sc_fab{position:absolute;top:12px;right:10px;pointer-events:auto;transform-origin:center;',
    to: '.sc_fab{position:absolute;top:0;right:0;pointer-events:auto;transform-origin:center;',
    expectFail: ['F9'],
  },
  {
    name: 'M61 折叠圆钮去掉描边（不再像宿主那颗按钮）',
    from: "border:1px solid var(--dsw-alias-border-l2);border-radius:999px;box-shadow:var(--dsw-shadow-lv2)",
    to: "border:0;border-radius:999px;box-shadow:var(--dsw-shadow-lv2)",
    expectFail: ['F9'],
  },
  {
    name: 'M64 文件类型一律落到 other（不再按扩展名分类）',
    from: "      if (FILE_EXT_KINDS[ext] !== undefined) return FILE_EXT_KINDS[ext];",
    to: "      if (FILE_EXT_KINDS[ext] !== undefined) return 'other';",
    expectFail: ['F15'],
  },
  {
    name: 'M65 文件类型色退回单一前景色（不再按类型上色）',
    from: "'.sc_fileIcon[data-kind=code],.sc_fileIcon[data-kind=html],.sc_fileIcon[data-kind=markdown]{color:var(--dsw-static-deepseek-500)}',",
    to: "'.sc_fileIcon[data-kind=code],.sc_fileIcon[data-kind=html],.sc_fileIcon[data-kind=markdown]{color:var(--sc-fg)}',",
    expectFail: ['F15'],
  },
  {
    name: 'M66 彩色图标丢掉类型标记（只剩一张空页形）',
    from: "      if (mark !== undefined) {",
    to: "      if (mark === undefined) {",
    expectFail: ['F15'],
  },
  {
    name: 'M67 语言不再分家（.js 退回通用 code 类型）',
    from: "      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',",
    to: "      js: 'code', mjs: 'code', cjs: 'code', jsx: 'code',",
    expectFail: ['F15'],
  },
  {
    name: 'M68 两种语言共用同一个颜色（ts 与 js 同色）',
    from: "'.sc_fileIcon[data-kind=typescript]{color:var(--dsw-static-blue-500)}',",
    to: "'.sc_fileIcon[data-kind=typescript]{color:var(--dsw-static-amber-500)}',",
    expectFail: ['F15'],
  },
  {
    name: 'M69 计划地址退回三段（右栏认不出，点开必抛错）',
    from: 'return `${PLAN_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(callId)}`;',
    to: 'return `${PLAN_PREFIX}session/${encodeURIComponent(sessionId)}/${encodeURIComponent(callId)}`;',
    expectFail: ['P2'],
  },
  {
    name: 'M70 成员副行丢掉模式（「可继续 / 一次性」不再显示）',
    from: 'const line = [subagent.title, modeText(t, subagent.mode), activity]',
    to: 'const line = [subagent.title, activity]',
    expectFail: ['F12'],
  },
  {
    name: 'M71 分区头又挂回图标列（标题前多一颗图标）',
    from: "const children = [h('span', { key: 'title', className: 'sc_blockTitle' }, title)];",
    to: "const children = [h('span', { key: 'lead', className: 'sc_secLead' }, h(Icon, { name: 'task', size: 14 })), h('span', { key: 'title', className: 'sc_blockTitle' }, title)];",
    expectFail: ['F17'],
  },
  {
    name: 'M72 计划行又铺上一层底色（不再与上方内容同宽）',
    from: 'padding:4px 6px;color:var(--sc-fg-strong);background:0 0;',
    to: 'padding:10px 10px;color:var(--sc-fg-strong);background:var(--sc-surface);',
    expectFail: ['F11'],
  },
  {
    name: 'M73 token 与耗时又并成一行（两串数字连读）',
    from: '.sc_memberTail{align-items:flex-end;flex-direction:column;gap:1px;',
    to: '.sc_memberTail{align-items:flex-end;flex-direction:row;gap:8px;',
    expectFail: ['F12'],
  },
  {
    name: 'M74 子智能体行退回不可点（丢掉 uiWorkspace.openSession）',
    from: "          onOpen: typeof onOpenSubagent === 'function' ? () => onOpenSubagent(subagent) : undefined,",
    to: '          onOpen: undefined,',
    expectFail: ['F18'],
  },
  {
    name: 'M75 子智能体行又各带一块底色（不再与上方内容同宽）',
    from: "width:calc(100% + 12px);margin:0 -6px 2px;padding:6px;border-radius:var(--dsw-radius-sm);background:0 0;",
    to: "width:100%;margin:0 0 4px;padding:7px 10px;border-radius:10px;background:var(--sc-surface);",
    expectFail: ['F12'],
  },
  {
    name: 'M76 又在多条记录之间加回分隔线（用户嫌丑的那条）',
    from: "      '.sc_member:last-child{margin-bottom:0}',",
    to: "      '.sc_member:last-child{margin-bottom:0}',\n      '.sc_rows > .sc_row + .sc_row > .sc_member{box-shadow:inset 0 1px 0 var(--sc-line)}',",
    expectFail: ['F12'],
  },
  {
    name: 'M77 目标正文又铺回一块底色（裸文本变浅灰卡）',
    from: "font-size:13px;line-height:19px;margin:8px 0 0;padding:0;background:0 0}',",
    to: "font-size:13px;line-height:19px;margin:8px 0 0;padding:8px 10px;background:var(--sc-surface)}',",
    expectFail: ['F11'],
  },
  {
    name: 'M78 计划行丢掉行首的灯泡图标',
    from: "            h('span', { key: 'icon', className: 'sc_planIcon' }, h(Icon, { key: 'bulb', name: 'bulb', size: 14 })),\n",
    to: '',
    expectFail: ['F11'],
  },
  {
    name: 'M79 灯泡丢掉光晕（退回普通线性图标）',
    from: ";filter:drop-shadow(0 0 3px var(--sc-accent)) drop-shadow(0 0 7px var(--sc-accent))",
    to: '',
    expectFail: ['F11'],
  },
  {
    name: 'M80 灯泡画成实心（用户否掉的那版）',
    from: "h('span', { key: 'icon', className: 'sc_planIcon' }, h(Icon, { key: 'bulb', name: 'bulb', size: 14 })),",
    to: "h('span', { key: 'icon', className: 'sc_planIcon' }, h(Icon, { key: 'bulb', name: 'bulb', size: 14, filled: true })),",
    expectFail: ['F11'],
  },
  {
    name: 'M81 灯泡丢掉周围的闪光点（只剩裸灯罩）',
    from: "        'M8 1.1v.6',\n        'M2.6 4.3l.5.3',\n        'M13.4 4.3l-.5.3',\n        'M3 8.9l.6-.2',\n        'M13 8.9l-.6-.2',\n",
    to: '',
    expectFail: ['F11'],
  },
  // ---- 第十五轮（会话区自适应：推让 + 自动收起）新增 ----
  {
    name: 'M82 推让量忘了乘 2（居中列只左移一半，卡片还是压住正文）',
    from: 'const padding = Math.round((collapsed ? fabFit.push : fit.push) * 2);',
    to: 'const padding = Math.round(collapsed ? fabFit.push : fit.push);',
    expectFail: ['L2', 'L4'],
  },
  {
    name: 'M83 推不动也不收起（tight 恒 false，卡片一直压在正文上）',
    from: 'const autoTight = measurable && fit.need > fit.available - slack;',
    to: 'const autoTight = false;',
    expectFail: ['L3', 'L6'],
  },
  {
    name: 'M84 手动展开被自动逻辑立刻翻回（点了等于没点）',
    from: 'const collapsed = wanted !== null ? wanted : (measurable ? autoTight : collapsedMemory);',
    to: 'const collapsed = measurable ? autoTight : collapsedMemory;',
    expectFail: ['L4', 'L5'],
  },
  {
    name: 'M85 去掉滞回死区（临界点上收放抖动）',
    from: 'const slack = autoCollapsed ? FIT_HYSTERESIS : 0;',
    to: 'const slack = 0;',
    expectFail: ['L9'],
  },
  {
    name: 'M86 手动选择跨宽度沿用（宽度变了还死守旧选择）',
    from: 'const signature = measurable ? `${contentWidth}:${chatWidth}` : \'\';',
    to: "const signature = 'fixed';",
    expectFail: ['L5'],
  },
  // ---- 第十六轮（状态条换成「本轮耗时」）新增 ----
  {
    name: 'M87 超过一分钟也只用秒显示（3m12s 退回 12s）',
    from: "      if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;\n",
    to: '',
    expectFail: ['B8'],
  },
  {
    name: 'M88 「等你」那一段永远不出现',
    from: '      if (waited > 0) {',
    to: '      if (false) {',
    expectFail: ['B8', 'F13', 'F20'],
  },
  {
    name: 'M89 「等你」没有用当前时刻减去起点（显示成一串天文数字）',
    from: '        ? Math.max(0, now - timing.waitSince)',
    to: '        ? Math.max(0, timing.waitSince)',
    expectFail: ['B8'],
  },
  {
    name: 'M90 总耗时标签用强色（和细分量词不一致，层级糊掉）',
    from: "'.sc_timingLabel{flex:none;color:var(--sc-fg-weak)}',",
    to: "'.sc_timingLabel{flex:none;color:var(--sc-fg-strong)}',",
    expectFail: ['F13'],
  },
  {
    name: 'M91 耗时条又铺回灰底圆角（退回一张小卡片）',
    from: "'.sc_bar{margin:2px 0 8px;display:flex}',",
    to: "'.sc_bar{margin:2px 0 8px;padding:4px;border-radius:12px;background:var(--sc-surface);display:flex}',",
    expectFail: ['F13'],
  },
  {
    name: 'M92 总计不累加（只把模型时间当总耗时）',
    from: '        { key: \'total\', name: t(\'timing.total\'), value: formatClock(totalMs), total: true },',
    to: '        { key: \'total\', name: t(\'timing.total\'), value: formatClock(modelMs), total: true },',
    expectFail: ['B8'],
  },
  {
    name: 'M93 总耗时数值退回升强色（和细分数值不一致，四段分两档）',
    from: "'.sc_timingValue{color:var(--sc-fg);font-weight:600;",
    to: "'.sc_timingValue{color:var(--sc-fg-strong);font-weight:600;",
    expectFail: ['F13'],
  },
  {
    name: 'M94 总计又放大一档（14px，四段不再同一档）',
    from: "'.sc_timingTotalValue{flex:none;color:var(--sc-fg);",
    to: "'.sc_timingTotalValue{flex:none;color:var(--sc-fg);font-size:14px;",
    expectFail: ['F13'],
  },
  {
    name: 'M95 总计标签退回「本轮耗时」（文案又长了）',
    from: "      'timing.total': '本轮',\n",
    to: "      'timing.total': '本轮耗时',\n",
    expectFail: ['B8'],
  },
  {
    name: 'M96 琥珀预设映射到红色色阶（两档预设撞成同色）',
    from: "'.sc_card[data-sc-theme=amber],.sc_themeChip[data-sc-theme=amber]{--sc-theme:var(--dsw-static-amber-500)}',",
    to: "'.sc_card[data-sc-theme=amber],.sc_themeChip[data-sc-theme=amber]{--sc-theme:var(--dsw-static-red-500)}',",
    expectFail: ['TH1'],
  },
  {
    name: 'M97 卡片根不再带 data-sc-theme（选了主题也不换色）',
    from: "          'data-sc-theme': theme,\n",
    to: '',
    expectFail: ['TH2'],
  },
  {
    name: 'M98 每个色点都标成选中（看不出当前是哪一档）',
    from: "'aria-pressed': theme === preset.id ? 'true' : 'false',",
    to: "'aria-pressed': 'true',",
    expectFail: ['TH3'],
  },
  {
    name: 'M99 主题不落盘（刷新就回到绿色）',
    from: "        globalThis.localStorage?.setItem(THEME_KEY, id);\n",
    to: '',
    expectFail: ['TH4'],
  },
  {
    name: 'M100 不回读落盘值（刷新丢主题）',
    from: 'return isThemeId(stored) ? stored : DEFAULT_THEME;',
    to: 'return DEFAULT_THEME;',
    expectFail: ['TH4'],
  },
  // ---- 第十七轮（按轮次折叠子智能体 + 等你补齐）新增 ----
  {
    name: 'M101 把轮次结束后的空闲又算进「等你」（对话都结束了数字还在涨）',
    from: '      const waited = waitMs + liveWait;',
    to: "      const waited = waitMs + liveWait + (typeof timing.idleSince === 'number' && typeof now === 'number' ? Math.max(0, now - timing.idleSince) : 0);",
    expectFail: ['F20'],
  },
  {
    name: 'M102 子智能体不再按轮次折叠（多轮委派全平铺）',
    from: '      if (groups.rounds.length === 0) {',
    to: '      if (true) {',
    expectFail: ['F19'],
  },
  {
    name: 'M103 计数 pill 只算当前轮（和「队友 N · 任务 x/y」不对应）',
    from: '          badge: groupDigits(total),',
    to: '          badge: groupDigits(currentRows.length),',
    expectFail: ['F19'],
  },
];

/**
 * 跑一次冒烟：`only` 给了就只跑这几条（透传 SC_ONLY），变异测试因此不必为每条变异跑全量。
 * 用 spawn 而不是 spawnSync，才能把 103 条变异压进一个并发池里跑。
 */
const run = (targetFile, only) => new Promise((resolve) => {
  const env = { ...process.env, SC_TARGET: targetFile };
  if (only && only.length > 0) env.SC_ONLY = only.join(',');
  else delete env.SC_ONLY;
  const child = spawn(process.execPath, [SMOKE], { env });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.on('close', (status) => {
    const failed = [...out.matchAll(/^FAIL (\S+)/gmu)].map((match) => match[1]);
    const summary = out.match(/(\d+)\/(\d+) passed/u);
    resolve({ code: status, failed, out, summary: summary?.[0] ?? '（无汇总）' });
  });
});

// 并发度：留一颗核给编辑器/浏览器，最多 8。变异之间互不共享状态（各自一份临时副本），可安全并行。
const LIMIT = Math.max(2, Math.min(8, cpus().length - 1));
const started = Date.now();

const report = (line, detail) => {
  console.log(line);
  if (detail) console.log(detail);
};

// 对照组：未经变异的真实文件必须全绿（全量跑，不走 SC_ONLY）
const control = await run(REAL);
let ok = control.code === 0 && control.failed.length === 0;
report(`${ok ? 'PASS' : 'FAIL'} M0 对照组（未变异真实文件）：${control.summary} exit=${control.code}`, ok ? null : control.out);

const jobs = [];
for (const [index, mutation] of MUTATIONS.entries()) {
  if (!SRC.includes(mutation.from)) {
    jobs.push({ index, mutation, missing: true });
    continue;
  }
  const file = path.join(DIR, `client-m${index + 1}.js`);
  writeFileSync(file, SRC.split(mutation.from).join(mutation.to), 'utf8');
  jobs.push({ index, mutation, file });
}

// 顺序输出（结果可能乱序完成，打印必须稳定，否则日志没法逐行对比）
const lines = new Array(jobs.length);
let printed = 0;
const flush = () => {
  while (printed < lines.length && lines[printed] !== undefined) {
    report(lines[printed].line, lines[printed].detail);
    if (!lines[printed].good) ok = false;
    printed += 1;
  }
};

let cursor = 0;
const worker = async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor];
    cursor += 1;
    if (job.missing) {
      lines[job.index] = { good: false, line: `FAIL ${job.mutation.name} —— 变异锚点在源文件里找不到，无法验证` };
      flush();
      continue;
    }
    const result = await run(job.file, job.mutation.expectFail);
    const missed = job.mutation.expectFail.filter((prefix) => !result.failed.includes(prefix));
    const good = result.code !== 0 && missed.length === 0;
    lines[job.index] = {
      good,
      line: `${good ? 'PASS' : 'FAIL'} ${job.mutation.name}：期望失败 ${JSON.stringify(job.mutation.expectFail)}，实际失败 ${JSON.stringify(result.failed)}，exit=${result.code}`,
      detail: good ? null : result.out,
    };
    flush();
  }
};

await Promise.all(Array.from({ length: Math.min(LIMIT, jobs.length) }, () => worker()));

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(ok ? `\n变异测试全部符合预期（断言具备区分度，${MUTATIONS.length} 条，并发 ${LIMIT}，${seconds}s）` : `\n变异测试存在问题（断言可能是恒真/锚点失效，${seconds}s）`);
process.exitCode = ok ? 0 : 1;
