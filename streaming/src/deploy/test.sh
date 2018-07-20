start bash -c "node ./dist/receiver.js"

#scp ./dist/sender.js pi@192.168.0.205:~/
# sender.js kills previous sender.js, which means the previous start bach ssh command will close,
#   as the previous command will have finished. So... that's convenient
#start bash -c "ssh pi@192.168.0.205 \"node ./sender.js\""

start bash -c "node ./dist/senderWrap.js"



#node ./dist/receiver.js &
#node ./dist/sender.js

#ffmpeg -y -r 10 -i a.mjpeg -filter:v "setpts=PTS/10" -c libx264 b.mp4
#ffmpeg -y -i b.mp4 -filter:v "drawtext=fontfile=/usr/share/fonts/truetype/DroidSans.ttf: text=(frame %{eif\\\:n\\\:d}): r=25: x=lh*0.5 + 2: y=lh * 2.5 + 2: fontcolor=white: box=1: boxcolor=0x00000000@1" -c libx264 c.mp4

#ffmpeg -y -i a.mp4 -c mjpeg b.mjpeg

#ffmpeg -y -i a.mp4 -c mjpeg b.mjpeg

#ffmpeg -y -i a.mp4 -ss 00:00:00 -t 00:00:07.7 b.mp4

# ffmpeg -y -r 10 -i a.mjpeg -filter:v "fps=10 [a]; [a] setpts=PTS/10 [out]" -c libx264 b.mp4