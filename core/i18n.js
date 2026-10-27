// UI strings. English is the default; Vietnamese is included.
// To add a language: copy `en`, translate, and add it to DICTS.

import { fmtUsd, shortPath } from './util.js';

const en = {
  status: {
    idle: 'idle', thinking: 'thinking', reading: 'reading', writing: 'writing code', running: 'running a command',
    web: 'browsing the web', delegating: 'delegating', planning: 'planning', tool: 'using a tool',
    permission: 'needs your approval', waiting: 'waiting for you', compacting: 'compacting memory', done: 'done',
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
  },
  alert: {
    loop: (p) => `${p.who} is going in circles: ${p.call} repeated ${p.times}×`,
    errorEcho: (p) => `${p.who} keeps hitting the same error (${p.times}×)`,
    stall: (p) => `${p.who}: ${p.tools} tool calls, ${fmtUsd(p.usd)} spent, no edits for ${p.minutes} min`,
    context: (p) => `${p.who}'s context is ${p.pct}% full`,
    permission: (p) => `${p.who} has waited ${p.seconds}s for your approval (${p.tool || 'tool'})`,
    permissionSub: (p) => `Subagent ${p.who} is stuck on a permission prompt (${p.seconds}s)`,
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
    budget: 'You set this budget. Pause or raise it in ~/.agent-village/config.json.',
    collision: 'Two agents in one working copy. Use a git worktree per agent.',
    compactRisk: 'Subagent reports may have been summarised away. Re-check their results.',
  },
};

const vi = {
  status: {
    idle: 'đang rảnh', thinking: 'đang suy nghĩ', reading: 'đang đọc', writing: 'đang viết code', running: 'đang chạy lệnh',
    web: 'đang lướt web', delegating: 'đang giao việc', planning: 'đang lên kế hoạch', tool: 'đang dùng tool',
    permission: 'cần bạn duyệt', waiting: 'đang chờ bạn', compacting: 'đang nén bộ nhớ', done: 'xong',
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
  },
  alert: {
    loop: (p) => `${p.who} đang lặp vòng: ${p.call} lặp ${p.times} lần`,
    errorEcho: (p) => `${p.who} gặp lại cùng một lỗi (${p.times} lần)`,
    stall: (p) => `${p.who}: ${p.tools} tool call, tốn ${fmtUsd(p.usd)}, ${p.minutes} phút chưa sửa file nào`,
    context: (p) => `Context của ${p.who} đã đầy ${p.pct}%`,
    permission: (p) => `${p.who} chờ bạn duyệt ${p.seconds}s (${p.tool || 'tool'})`,
    permissionSub: (p) => `Subagent ${p.who} kẹt ở bước xin quyền (${p.seconds}s)`,
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
    budget: 'Bạn đã đặt ngân sách này. Tạm dừng hoặc nâng trong ~/.agent-village/config.json.',
    collision: 'Hai agent chung một thư mục. Dùng git worktree riêng cho mỗi agent.',
    compactRisk: 'Báo cáo của subagent có thể đã bị tóm tắt mất. Kiểm tra lại kết quả.',
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
