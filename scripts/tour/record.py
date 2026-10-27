# Records the feature tour used for the README GIFs.
#   node bin/swarmstead.js start &      # in another terminal
#   python3 scripts/tour/record.py && scripts/tour/cut.sh
# Needs Python Playwright (pip install playwright && playwright install chromium) and ffmpeg.
import os, time
from playwright.sync_api import sync_playwright
S = os.environ.get('TOUR_DIR', '.tour') + '/'
BASE = os.environ.get('SWARMSTEAD_URL', 'http://127.0.0.1:4317')
os.makedirs(S + 'rec', exist_ok=True)
for f in os.listdir(S + 'rec'):
    if f.endswith('.webm'): os.remove(S + 'rec/' + f)
OVERLAY = r"""
(() => {
  const st = document.createElement('style');
  st.textContent = `#rec-cap{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:99;background:#120e1bee;border:3px solid #b18cff;color:#fff;
    font:600 17px/1.35 'Silkscreen',ui-monospace,monospace;padding:10px 18px;box-shadow:0 6px 0 #0008;max-width:92vw;text-align:center;transition:opacity .25s}
    #rec-cap b{color:#ffd34d;margin-right:8px}
    #rec-cur{position:fixed;z-index:100;width:22px;height:22px;pointer-events:none;left:0;top:0;transition:left .45s ease,top .45s ease}
    #rec-cur.click::after{content:'';position:absolute;left:-10px;top:-10px;width:22px;height:22px;border:3px solid #ffd34d;border-radius:50%;animation:rp .4s ease-out}
    @keyframes rp{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}`;
  st.textContent += `.stage-wrap{height:50vh !important}.party{max-height:calc(50vh - 150px) !important}.pane{max-height:236px !important}body{padding-bottom:78px}html{overflow:hidden}`;
  document.head.appendChild(st);
  const cap = document.createElement('div'); cap.id = 'rec-cap'; cap.style.opacity = 0; document.body.appendChild(cap);
  const cur = document.createElement('div'); cur.id = 'rec-cur';
  cur.innerHTML = '<svg viewBox="0 0 11 11" width="22" height="22" shape-rendering="crispEdges"><path d="M0 0h1v1h1v1h1v1h1v1h1v1h1v1h1v1H4v1H3v1H2v1H1v1H0z" fill="#000"/><path d="M1 2h1v1h1v1h1v1h1v1h1v1H4v1H3v1H2v1H1z" fill="#fff"/></svg>';
  document.body.appendChild(cur);
  window.__cap = (n, t) => { cap.innerHTML = n ? `<b>${n}</b>${t}` : t; cap.style.opacity = t ? 1 : 0; };
  window.__cur = (x, y, click) => { cur.style.left = x + 'px'; cur.style.top = y + 'px'; if (click) { cur.classList.remove('click'); void cur.offsetWidth; cur.classList.add('click'); } };
})();
"""
def center(pg, sel):
    b = pg.locator(sel).first.bounding_box()
    return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 1160}, record_video_dir=S + 'rec', record_video_size={'width': 1440, 'height': 1160})
    pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE + '/web/?demo&speed=3&lang=en')
    pg.wait_for_timeout(800)
    pg.evaluate(OVERLAY)
    t0 = time.time()
    marks = {}
    def cap(n, t): pg.evaluate('([n,t]) => window.__cap(n,t)', [n, t])
    def click(sel):
        x, y = center(pg, sel)
        pg.evaluate('([x,y]) => window.__cur(x,y,false)', [x, y]); pg.wait_for_timeout(550)
        pg.evaluate('([x,y]) => window.__cur(x,y,true)', [x, y]); pg.click(sel); pg.wait_for_timeout(250)
    pg.evaluate('window.__cur(900, 500, false)')
    cap('', 'Every Claude Code / Codex session is a pixel character. Subagents walk through the portal.')
    marks['start'] = time.time() - t0
    pg.wait_for_timeout(4000)
    # 1. approvals
    for i in range(200):
        if pg.is_visible('#approvals'): break
        pg.wait_for_timeout(100)
    marks['approval'] = time.time() - t0
    cap('1', 'Approve or deny permission prompts from the village, or from your phone')
    pg.wait_for_timeout(2600)
    marks['ap_box'] = pg.evaluate("(()=>{const r=document.querySelector('#approvals').getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(Math.round)})()")
    if pg.is_visible('#approvals-list .btn.ok'): click('#approvals-list .btn.ok')
    pg.wait_for_timeout(1800)
    # 3/4. monster board
    cap('3+4', 'Catches "all tests pass" with no test run, same-file edits, and merge conflicts across worktrees')
    click('[data-tab="alerts"]')
    pg.wait_for_timeout(4200)
    # 5. ledger
    cap('5', 'Cost per commit and per PR, from agent git commands and your own commits')
    click('[data-tab="ledger"]')
    pg.wait_for_timeout(3800)
    # workflow arena (wait for it)
    for i in range(300):
        if pg.evaluate("document.querySelector('#view-now')?.textContent?.toLowerCase().includes('arena')"): break
        pg.wait_for_timeout(100)
    marks['arena'] = time.time() - t0
    cap('2', 'Big runs move to the Arena: stages, squads, and a cost forecast from your past runs')
    pg.wait_for_timeout(6500)
    cap('2', 'Timeline of every agent in the workflow. Reports fly back to the orchestrator')
    click('[data-tab="timeline"]')
    pg.wait_for_timeout(5500)
    cap('', 'Characters evolve from how well they work (clean turns, cache hits, fixed tests), not from spend')
    click('[data-tab="roster"]')
    pg.wait_for_timeout(4000)
    # 6. replay + post-mortem
    cap('6', 'Replay any day at 1-120x ...')
    click('#b-replay')
    pg.wait_for_timeout(3500)
    cap('6', '... and get a post-mortem: where the money went, what was wasted, copy as Markdown')
    click('#rp-pm')
    pg.wait_for_timeout(4500)
    pg.mouse.wheel(0, 400); pg.wait_for_timeout(1500)
    click('#pm-close')
    cap('', 'Open source, MIT  ·  github.com/ngoanpv/swarmstead')
    click('#rp-exit')
    pg.wait_for_timeout(3000)
    marks['end'] = time.time() - t0
    marks['h'] = pg.evaluate('document.documentElement.scrollHeight')
    marks['boxes'] = pg.evaluate('''Object.fromEntries(['header','#stage','.bottom','aside','main'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [s,[r.x,r.y,r.width,r.height].map(Math.round)]}))''')
    print(marks, errs[:5])
    ctx.close(); b.close()
