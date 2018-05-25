# The bitrate is set based on the camera I have now, it should depend on the remote quality.
# Don't bother setting the framerate. Apparently even if we change the framerate the text drawing filter draws the source frame number. So
#   it is more accurate to leave the framerate so that the frame number is the output frame number.

ffmpeg -y -i http://192.168.0.201:8080 -c:v copy -f segment -segment_time 7.7 -reset_timestamps 1 test%d.mp4

#ffmpeg -y -i http://192.168.0.201:8080 -c libx264 -b:v 1M -f segment -strftime 1 -reset_timestamps 1 \
#-segment_time 60 \
#-vf "drawtext=fontfile=/usr/share/fonts/truetype/DroidSans.ttf: text=%{localtime\\\:%Y-%m-%d %I\\\\\\\\\\\:%M\\\\\\\\\\\:%S %p %Z} (frame %{eif\\\:n\\\:d}): r=25: x=lh*0.5 + 2: y=lh * 0.5 + 2: fontcolor=white: box=1: boxcolor=0x00000000@1" \
#raw/video%Y-%m-%d_%H-%M-%S_%d.mp4


#%Y-%m-%d %I\:%M\:%S %P %Z

#x=(w-tw)/2: y=h-(2*lh)
#x=lh*0.5: y=h-lh*1.5

# https://stackoverflow.com/questions/28602281/specify-timestamp-in-ffmpeg-video-segment-command
# ffmpeg -i your_input -f segment -strftime 1 -segment_time 60 -segment_format mp4 out%Y-%m-%d_%H-%M-%S.mp4

#ffmpeg -i http://192.168.2.13:8080 -c:v libx264 -crf 0 -f segment -segment_time 10 'video%03d.avi'

#ffmpeg -i http://192.168.2.13:8080 -c copy -crf 0 -f segment -segment_time 10 'video%03d.avi'

#vlc v4l2:///dev/video0 --sout "#transcode{vcodec=mjpg}:std{access=http{mime=multipart/x-xed-replace;boundary=-7b3cc56e5f51db803f790dad720ed50a},mux=mpjpeg,dst=0.0.0.0:8080}"

#vlc v4l2:///dev/video0 --sout "#transcode{vcodec=h264}:std{access=http,mux=ogg,dst=0.0.0.0:8080}"
