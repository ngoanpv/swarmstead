# Swarmstead icon: a fox-eared cottage (the "stead") with glowing window eyes,
# and a few sparks around it (the swarm). Drawn on a 32x32 grid.
import sys
from PIL import Image
N = 32
OUT = sys.argv[1] if len(sys.argv) > 1 else 'docs/brand'  # python3 scripts/brand/make-icon.py [outdir]  (needs Pillow)
C = {
  'bg0': (28, 22, 41), 'bg1': (42, 31, 69), 'ol': (11, 8, 20),
  'or': (240, 138, 62), 'orL': (255, 178, 102), 'orD': (196, 98, 40),
  'ear': (122, 59, 46), 'wall': (243, 227, 195), 'wallD': (214, 191, 152),
  'win': (255, 211, 77), 'winL': (255, 243, 176), 'door': (110, 66, 40), 'doorD': (78, 45, 28), 'knob': (255, 211, 77),
  'grass': (88, 180, 92), 'grassD': (54, 128, 66), 'vio': (177, 140, 255), 'teal': (95, 211, 200), 'gold': (255, 211, 77), 'pink': (255, 120, 150),
  'snout': (255, 240, 220),
}
fg = [[None] * N for _ in range(N)]
def px(x, y, c):
    if 0 <= x < N and 0 <= y < N: fg[y][x] = c
def rect(x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1): px(x, y, c)

# ears (tips at x=8 and x=23)
for i in range(6):
    y = 3 + i
    for x in range(8, 8 + i + 1): px(x, y, 'or')
    for x in range(23 - i, 24): px(x, y, 'or')
for i in range(1, 5):   # inner ears
    y = 4 + i
    for x in range(9, 9 + i - 1 + 1): px(x, y, 'ear') if x < 8 + i else None
    for x in range(23 - i + 1, 23): px(x, y, 'ear') if x > 23 - i else None
# roof / head
for y in range(9, 17):
    grow = min(y - 9, 2)
    rect(8 - grow, y, 23 + grow, y, 'or')
rect(7, 8, 24, 8, 'or')
# light and shade on the roof
rect(8, 8, 14, 8, 'orL'); rect(7, 9, 8, 12, 'orL'); px(9, 9, 'orL'); px(8, 5, 'orL'); px(8, 6, 'orL'); px(9, 7, 'orL')
rect(6, 16, 25, 16, 'orD')
rect(22, 12, 25, 15, 'orD'); rect(23, 11, 23, 11, 'orD')
# snout / muzzle on the roof edge (gives the fox face)
rect(13, 13, 18, 15, 'snout'); rect(14, 12, 17, 12, 'snout'); rect(15, 13, 16, 13, 'ol')
# happy closed eyes (^ ^)
for ex in (9, 19):
    px(ex, 12, 'ol'); px(ex + 1, 11, 'ol'); px(ex + 2, 11, 'ol'); px(ex + 3, 12, 'ol')
# blush
px(9, 14, 'pink'); px(22, 14, 'pink')
# walls
rect(9, 17, 22, 27, 'wall')
rect(20, 17, 22, 27, 'wallD'); rect(9, 17, 22, 17, 'wallD')
# window eyes
for wx in (10, 18):
    rect(wx, 19, wx + 3, 22, 'win'); rect(wx, 19, wx + 1, 20, 'winL')
    rect(wx + 2, 19, wx + 2, 22, 'orD') if False else None
    px(wx + 1, 22, 'win')
# window muntins
for wx in (10, 18): rect(wx, 21, wx + 3, 21, 'door'); rect(wx + 2, 19, wx + 2, 22, 'door')
# door (mouth)
rect(14, 23, 17, 27, 'door'); rect(16, 23, 17, 27, 'doorD'); px(14, 25, 'knob')
rect(15, 22, 16, 22, 'door')
# grass
rect(5, 28, 26, 28, 'grass'); rect(7, 29, 24, 29, 'grassD')
for x in (6, 11, 19, 25): px(x, 27, 'grass')

# outline: transparent neighbours of filled cells
ol = [[False] * N for _ in range(N)]
for y in range(N):
    for x in range(N):
        if fg[y][x] is None:
            for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                xx, yy = x + dx, y + dy
                if 0 <= xx < N and 0 <= yy < N and fg[yy][xx] is not None: ol[y][x] = True
# sparks (the swarm), drawn after the outline so they float free
sparks = [((3, 12), 'vio'), ((27, 6), 'teal'), ((28, 19), 'gold'), ((3, 22), 'pink'), ((14, 1), 'gold')]

def render(scale, rounded=True, bg=True):
    img = Image.new('RGBA', (N * scale, N * scale), (0, 0, 0, 0))
    P = img.load()
    def fill(x, y, col):
        for yy in range(y * scale, (y + 1) * scale):
            for xx in range(x * scale, (x + 1) * scale): P[xx, yy] = col + (255,)
    for y in range(N):
        for x in range(N):
            if bg:
                corner = rounded and ((x < 2 and y < 2 and x + y < 2) or (x > 29 and y < 2 and (31 - x) + y < 2) or (x < 2 and y > 29 and x + (31 - y) < 2) or (x > 29 and y > 29 and (31 - x) + (31 - y) < 2))
                if not corner:
                    d = ((x - 15.5) ** 2 + (y - 13) ** 2) ** 0.5
                    t = max(0, min(1, 1 - d / 17))
                    col = tuple(int(C['bg0'][i] + (C['bg1'][i] - C['bg0'][i]) * t) for i in range(3))
                    # dithered stars
                    if (x * 7 + y * 13) % 41 == 0 and fg[y][x] is None and not ol[y][x]: col = (90, 78, 130)
                    fill(x, y, col)
            if ol[y][x]: fill(x, y, C['ol'])
            if fg[y][x]: fill(x, y, C[fg[y][x]])
    for (x, y), c in sparks:
        fill(x, y, C[c])
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            col = tuple(int(v * 0.55 + 28 * 0.45) for v in C[c])
            fill(x + dx, y + dy, col)
    return img

def svg(rounded=True):
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {N} {N}" shape-rendering="crispEdges">']
    img = render(1, rounded)
    P = img.load()
    for y in range(N):
        x = 0
        while x < N:
            c = P[x, y]
            if c[3] == 0: x += 1; continue
            x0 = x
            while x < N and P[x, y] == c: x += 1
            out.append(f'<rect x="{x0}" y="{y}" width="{x - x0}" height="1" fill="#{c[0]:02x}{c[1]:02x}{c[2]:02x}"/>')
    out.append('</svg>')
    return '\n'.join(out)

render(16).save(f'{OUT}/icon-512.png')
render(8).save(f'{OUT}/icon-256.png')
render(2).save(f'{OUT}/icon-64.png')
render(1).resize((32, 32)).save(f'{OUT}/icon-32.png')
render(16, bg=False).save(f'{OUT}/mark-512.png')
open(f'{OUT}/icon.svg', 'w').write(svg())
print('ok')
