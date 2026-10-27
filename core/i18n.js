// UI strings. English is the default; Vietnamese is included.
// To add a language: copy `en`, translate, and add it to DICTS.

import { fmtUsd, shortPath } from './util.js';

const en = {
  status: {
    idle: 'idle', thinking: 'thinking', reading: 'reading', writing: 'writing code', running: 'running a command',
    web: 'browsing the web', delegating: 'delegating', planning: 'planning', tool: 'using a tool',
    permission: 'needs your approval', waiting: 'waiting for you', compacting: 'compacting memory', exhausted: 'out of stamina', done: 'done',
  },
  ui: {
    treasury: 'Spent today', burn: 'Burn', tokens: 'Tokens', cache: 'Cache hits', block: '5h block',
    party: 'Party', alerts: 'Monster board', log: 'Quest log', roster: 'Bestiary', demo: 'DEMO',
    live: 'LIVE', offline: 'OFFLINE', noAlerts: 'All clear. Your agents are behaving.', context: 'Context',
    level: 'Lv', xp: 'XP', streak: 'Clean streak', bugs: 'Bugs slain', turns: 'Turns', next: 'Next evolution',
    stats: { focus: 'Focus', thrift: 'Thrift', craft: 'Craft', cache: 'Cache', grit: 'Grit' },
    traits: { scholar: 'Scholar', smith: 'Builder', engineer: 'Engineer', ranger: 'Ranger', commander: 'Commander' },
    sound: 'Sound', follow: 'Follow', speed: 'Speed', empty: 'No agents yet. Start Claude Code — someone will move in.',
    perMin: '/min', left: 'left', evolved: 'evolved into', hatched: 'hatched into', levelUp: 'Level up!',
    shiny: 'became SHINY!', handoff: 'handoff', cost: 'cost', model: 'model',
    room: 'Room', arena: 'Arena', timeline: 'Timeline', inbox: 'Reports', run: 'Run', stage: 'Stage',
    running: 'running', queued: 'queued', doneN: 'done', failedN: 'failed', agents: 'agents', noRun: 'No subagent run yet. Fan-outs and workflows show up here.',
    outcome: { clean: 'clean', rough: 'rough', failed: 'failed', lost: 'maybe lost' },
    mode: { plan: 'plan mode', acceptEdits: 'auto-accept edits', bypassPermissions: 'permissions bypassed', auto: 'auto mode', default: 'default', dontAsk: "don't ask" },
    effort: 'effort', background: 'background', worktree: 'worktree', team: 'team', parallel: 'parallel', thinking: 'thinking tokens',
    arenaAuto: 'Big run detected: switched to the Arena', allIn: 'ALL REPORTS IN',
  },
  alert: {
    loop: (p) => p.swarm ? `${p.count} subagents of ${p.who} are going in circles` : `${p.who} is going in circles: ${p.call} repeated ${p.times}×`,
    errorEcho: (p) => p.swarm ? `${p.count} subagents of ${p.who} keep hitting the same error` : `${p.who} keeps hitting the same error (${p.times}×)`,
    stall: (p) => p.swarm ? `${p.count} subagents of ${p.who} are spending without edits` : `${p.who}: ${p.tools} tool calls, ${fmtUsd(p.usd)} spent, no edits for ${p.minutes} min`,
    context: (p) => p.swarm ? `${p.count} subagents of ${p.who} are near full context` : `${p.who}'s context is ${p.pct}% full`,
    permission: (p) => `${p.who} has waited ${p.seconds}s for your approval (${p.tool || 'tool'})`,
    permissionSub: (p) => p.swarm ? `${p.count} subagents of ${p.who} are stuck on permission prompts` : `Subagent ${p.who} is stuck on a permission prompt (${p.seconds}s)`,
    exhausted: (p) => p.swarm ? `${p.count} subagents of ${p.who} hit ${String(p.reason).replace(/_/g, ' ')}` : `${p.who} stopped: ${String(p.reason).replace(/_/g, ' ')}`,
    bypass: (p) => `${p.who} is running with permissions bypassed`,
    straggler: (p) => p.swarm ? `${p.count} stragglers in ${p.who}'s run` : `${p.who} is a straggler in "${p.stage}": ${p.minutes} min, ${p.factor}× the stage median`,
    sprawl: (p) => `${p.who} has launched ${p.total} agents (${p.perMin}/min)`,
    runBudget: (p) => `${p.who}'s run reached ${fmtUsd(p.spent)} (budget ${fmtUsd(p.budget)})`,
    waiting: (p) => `${p.who} has been waiting for you for ${p.minutes} min`,
    burn: (p) => `Burn rate ${fmtUsd(p.rate)}/min (limit ${fmtUsd(p.limit)}/min)`,
    budget: (p) => `Daily budget reached: ${fmtUsd(p.spent)} of ${fmtUsd(p.budget)}`,
    collision: (p) => `${p.a} and ${p.b} are both editing ${shortPath(p.file, 2)}`,
    compactRisk: (p) => `${p.who} auto-compacted while subagents were reporting back`,
  },
  hint: {
    loop: 'Interrupt (Esc) and give a new hint, or ask it to step back and explain what it is trying.',
    errorEcho: 'The fix is not working. Read the error yourself or ask for a different approach.',
    stall: 'Spending without progress. Check whether the task is clear enough.',
    context: 'Consider /compact with a focus note, or hand the rest to a fresh subagent.',
    permission: 'Switch to that terminal and approve or deny.',
    permissionSub: 'Background subagents cannot ask you. Add an allow rule to .claude/settings.json.',
    waiting: 'Your turn! The agent is idle.',
    burn: 'Several agents are spending fast. Check for loops before it adds up.',
    budget: 'You set this budget. Pause or raise it in ~/.swarmstead/config.json.',
    collision: 'Two agents in one working copy. Use a git worktree per agent.',
    compactRisk: 'Subagent reports may have been summarised away. Re-check their results.',
    exhausted: 'Rate limit or overload. Wait for the reset, or switch to a smaller model for routine steps.',
    bypass: 'Every tool runs without asking. Fine in a sandbox, risky on your real machine.',
    straggler: 'One agent is far slower than its peers. Check whether it is stuck or got a much harder slice.',
    sprawl: 'Many agents means many tokens. Check /workflows and the burn rate before it adds up.',
    runBudget: 'This run passed the budget you set. Pause it from /workflows if it is not worth it.',
  },
};

const vi = {
  status: {
    idle: 'đang rảnh', thinking: 'đang suy nghĩ', reading: 'đang đọc', writing: 'đang viết code', running: 'đang chạy lệnh',
    web: 'đang lướt web', delegating: 'đang giao việc', planning: 'đang lên kế hoạch', tool: 'đang dùng tool',
    permission: 'cần bạn duyệt', waiting: 'đang chờ bạn', compacting: 'đang nén bộ nhớ', exhausted: 'hết sức', done: 'xong',
  },
  ui: {
    treasury: 'Đã tiêu hôm nay', burn: 'Tốc độ đốt', tokens: 'Token', cache: 'Cache hit', block: 'Khối 5h',
    party: 'Đội hình', alerts: 'Bảng quái vật', log: 'Nhật ký', roster: 'Bách khoa', demo: 'DEMO',
    live: 'TRỰC TIẾP', offline: 'MẤT KẾT NỐI', noAlerts: 'Yên bình. Các agent đang ngoan.', context: 'Context',
    level: 'Lv', xp: 'XP', streak: 'Chuỗi sạch', bugs: 'Bug đã diệt', turns: 'Lượt', next: 'Tiến hoá tiếp',
    stats: { focus: 'Tập trung', thrift: 'Tiết kiệm', craft: 'Tay nghề', cache: 'Cache', grit: 'Bền bỉ' },
    traits: { scholar: 'Học giả', smith: 'Thợ code', engineer: 'Kỹ sư', ranger: 'Thám tử', commander: 'Chỉ huy' },
    sound: 'Âm thanh', follow: 'Theo dõi', speed: 'Tốc độ', empty: 'Chưa có agent. Mở Claude Code để có cư dân mới.',
    perMin: '/phút', left: 'còn', evolved: 'đã tiến hoá thành', hatched: 'đã nở thành', levelUp: 'Lên cấp!',
    shiny: 'đã hoá SHINY!', handoff: 'bàn giao', cost: 'chi phí', model: 'model',
    room: 'Phòng', arena: 'Đấu trường', timeline: 'Dòng thời gian', inbox: 'Báo cáo', run: 'Lượt chạy', stage: 'Giai đoạn',
    running: 'đang chạy', queued: 'đang chờ', doneN: 'xong', failedN: 'lỗi', agents: 'agent', noRun: 'Chưa có lượt chạy subagent nào. Fan-out và workflow sẽ hiện ở đây.',
    outcome: { clean: 'sạch', rough: 'trục trặc', failed: 'thất bại', lost: 'có thể mất' },
    mode: { plan: 'chế độ plan', acceptEdits: 'tự nhận sửa file', bypassPermissions: 'bỏ qua quyền', auto: 'chế độ auto', default: 'mặc định', dontAsk: 'không hỏi' },
    effort: 'mức effort', background: 'chạy nền', worktree: 'worktree', team: 'team', parallel: 'song song', thinking: 'token suy nghĩ',
    arenaAuto: 'Phát hiện lượt chạy lớn: chuyển sang Đấu trường', allIn: 'ĐÃ ĐỦ BÁO CÁO',
  },
  alert: {
    loop: (p) => p.swarm ? `${p.count} subagent của ${p.who} đang lặp vòng` : `${p.who} đang lặp vòng: ${p.call} lặp ${p.times} lần`,
    errorEcho: (p) => p.swarm ? `${p.count} subagent của ${p.who} gặp lại cùng một lỗi` : `${p.who} gặp lại cùng một lỗi (${p.times} lần)`,
    stall: (p) => p.swarm ? `${p.count} subagent của ${p.who} tốn tiền mà chưa sửa file` : `${p.who}: ${p.tools} tool call, tốn ${fmtUsd(p.usd)}, ${p.minutes} phút chưa sửa file nào`,
    context: (p) => p.swarm ? `${p.count} subagent của ${p.who} sắp đầy context` : `Context của ${p.who} đã đầy ${p.pct}%`,
    permission: (p) => `${p.who} chờ bạn duyệt ${p.seconds}s (${p.tool || 'tool'})`,
    permissionSub: (p) => p.swarm ? `${p.count} subagent của ${p.who} kẹt ở bước xin quyền` : `Subagent ${p.who} kẹt ở bước xin quyền (${p.seconds}s)`,
    exhausted: (p) => p.swarm ? `${p.count} subagent của ${p.who} gặp ${String(p.reason).replace(/_/g, ' ')}` : `${p.who} dừng lại: ${String(p.reason).replace(/_/g, ' ')}`,
    bypass: (p) => `${p.who} đang chạy với quyền bị bỏ qua`,
    straggler: (p) => p.swarm ? `${p.count} agent chậm trong lượt chạy của ${p.who}` : `${p.who} chậm bất thường ở "${p.stage}": ${p.minutes} phút, gấp ${p.factor} lần trung vị`,
    sprawl: (p) => `${p.who} đã sinh ${p.total} agent (${p.perMin}/phút)`,
    runBudget: (p) => `Lượt chạy của ${p.who} đã tốn ${fmtUsd(p.spent)} (ngân sách ${fmtUsd(p.budget)})`,
    waiting: (p) => `${p.who} đã chờ bạn ${p.minutes} phút`,
    burn: (p) => `Đang đốt ${fmtUsd(p.rate)}/phút (ngưỡng ${fmtUsd(p.limit)}/phút)`,
    budget: (p) => `Chạm ngân sách ngày: ${fmtUsd(p.spent)} / ${fmtUsd(p.budget)}`,
    collision: (p) => `${p.a} và ${p.b} cùng sửa ${shortPath(p.file, 2)}`,
    compactRisk: (p) => `${p.who} tự nén context đúng lúc subagent đang báo cáo`,
  },
  hint: {
    loop: 'Bấm Esc rồi gợi ý hướng khác, hoặc bảo nó dừng lại giải thích đang thử gì.',
    errorEcho: 'Cách sửa không ăn thua. Tự đọc lỗi hoặc yêu cầu đổi hướng.',
    stall: 'Tốn tiền mà chưa ra gì. Kiểm tra lại yêu cầu đã đủ rõ chưa.',
    context: 'Cân nhắc /compact kèm ghi chú trọng tâm, hoặc giao phần còn lại cho subagent mới.',
    permission: 'Chuyển sang terminal đó để duyệt hoặc từ chối.',
    permissionSub: 'Subagent chạy nền không hỏi bạn được. Thêm rule allow vào .claude/settings.json.',
    waiting: 'Tới lượt bạn! Agent đang rảnh.',
    burn: 'Nhiều agent đang tiêu nhanh. Kiểm tra vòng lặp trước khi hoá đơn phình to.',
    budget: 'Bạn đã đặt ngân sách này. Tạm dừng hoặc nâng trong ~/.swarmstead/config.json.',
    collision: 'Hai agent chung một thư mục. Dùng git worktree riêng cho mỗi agent.',
    compactRisk: 'Báo cáo của subagent có thể đã bị tóm tắt mất. Kiểm tra lại kết quả.',
    exhausted: 'Bị rate limit hoặc quá tải. Chờ reset, hoặc dùng model nhỏ hơn cho các bước thường.',
    bypass: 'Mọi tool chạy mà không hỏi. Ổn trong sandbox, rủi ro trên máy thật.',
    straggler: 'Một agent chậm hơn hẳn các agent cùng giai đoạn. Xem nó có bị kẹt hay nhận phần việc khó hơn nhiều.',
    sprawl: 'Nhiều agent đồng nghĩa nhiều token. Xem /workflows và tốc độ đốt trước khi hoá đơn phình to.',
    runBudget: 'Lượt chạy này đã vượt ngân sách bạn đặt. Dừng nó trong /workflows nếu không đáng.',
  },
};

export const DICTS = { en, vi };

export function getDict(lang) {
  const l = String(lang || 'en').toLowerCase().slice(0, 2);
  return DICTS[l] || en;
}

export function alertText(dict, alert) {
  const f = dict.alert[alert.kind] || en.alert[alert.kind];
  try { return f ? f(alert.params || {}) : alert.kind; } catch { return alert.kind; }
}

export function alertHint(dict, alert) {
  return dict.hint[alert.kind] || en.hint[alert.kind] || '';
}
