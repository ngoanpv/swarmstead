#!/bin/bash
# Cuts the README GIFs out of the tour recording, at the caption changes.
# Output: $TOUR_DIR/gifs/*.gif and swarmstead-tour.mp4 (copy them to docs/images and docs/media).
set -e
cd "${TOUR_DIR:-.tour}"
V=$(ls rec/*.webm)
rm -rf capf gifs && mkdir capf gifs
ffmpeg -v error -i "$V" -vf "fps=4,crop=900:70:270:1086,scale=180:14,format=gray" capf/%04d.png
T=$(python3 - <<'PY'
import glob
from PIL import Image
fs=sorted(glob.glob('capf/*.png')); prev=None; out=[]
for i,f in enumerate(fs):
    d=list(Image.open(f).getdata())
    if prev is not None and sum(abs(a-b) for a,b in zip(d,prev))/len(d)>6: out.append(i/4)
    prev=d
print(' '.join(str(x) for x in out))
PY
)
read -r -a C <<< "$T"
echo "caption changes: ${C[*]}"
# C: 0 intro, 1 approvals, 2 alerts, 3 ledger, 4 arena, 5 timeline, 6 bestiary, 7 replay, 8 post-mortem, 9 outro
pal(){ echo "split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle"; }
e(){ python3 -c "print($1)"; }
ffmpeg -v error -y -i "$V" -filter_complex "[0:v]trim=$(e "${C[0]}+0.2"):${C[1]},setpts=PTS-STARTPTS[x];[0:v]trim=$(e "${C[4]}+0.1"):${C[5]},setpts=PTS-STARTPTS[y];[x][y]concat=n=2:v=1,fps=8,scale=960:-1:flags=lanczos,$(pal)" gifs/tour-hero.gif
ffmpeg -v error -y -ss ${C[1]} -to ${C[2]} -i "$V" -filter_complex "fps=8,crop=880:720:560:0,$(pal)" gifs/approvals.gif
ffmpeg -v error -y -ss $(e "${C[2]}+0.05") -to ${C[3]} -i "$V" -filter_complex "fps=8,crop=1440:440:0:720,scale=960:-1:flags=lanczos,$(pal)" gifs/alerts.gif
ffmpeg -v error -y -ss $(e "${C[3]}+0.05") -to ${C[4]} -i "$V" -filter_complex "fps=8,crop=1440:440:0:720,scale=960:-1:flags=lanczos,$(pal)" gifs/ledger.gif
ffmpeg -v error -y -ss $(e "${C[5]}+0.05") -to ${C[6]} -i "$V" -filter_complex "fps=8,scale=960:-1:flags=lanczos,$(pal)" gifs/timeline.gif
ffmpeg -v error -y -ss $(e "${C[6]}+0.05") -to ${C[7]} -i "$V" -filter_complex "fps=8,crop=1440:440:0:720,scale=960:-1:flags=lanczos,$(pal)" gifs/evolution.gif
ffmpeg -v error -y -ss $(e "${C[7]}+0.05") -to $(e "${C[9]}-0.1") -i "$V" -filter_complex "fps=7,scale=960:-1:flags=lanczos,$(pal)" gifs/replay.gif
ffmpeg -v error -y -ss ${C[0]} -i "$V" -vf "scale=1440:-2" -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -movflags +faststart -an gifs/swarmstead-tour.mp4
ls -la gifs
