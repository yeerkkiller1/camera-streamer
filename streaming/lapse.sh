#lapse_html5.js
# We want to turn all segment videos into 10fps videos HTML5 (h264) videos, while giving them timestamps
# 	(maybe number them for fast reading, and then add their metadata to a file? Maybe all metadata to the same file?)
#lapse_concat.js (do 3 stages here, normal speed, 16x speed and 64x * 16x speed)
# Then we want to concatenate those videos into daily? (or maybe another size) chunks, and make them a further 16x speed at 40fps
#	and then make another one at 64x speed that
#ffmpeg_watchdog.js 
# Also, if ffmpeg doesn't write to the file for a certain amount of time, assume it's died and restart it
#	if it's a network issue it usually reconnects, but if the remote host actually reboots, ffmpeg won't reconnect

# If we could concatenate as new segment videos are created that would be great...

# get real end time from data modified. Get true duration from ffprobe -i video000.avi -show_entries "stream=nb_frames",
#	to get the frame count (and assume the fps, as we set it in download.sh), and then use that to get the real start time.

# (can't use crf with filter?, so we set bitrate instead)

# (Make h264 videos) (limit the bit rate, as the source video is shit, so we shouldn't make a super high quality output video)
ffmpeg -y -i video2018-05-23_19-00-36_23.avi -r 10 -b:v 1M -c libx264 chunk0.mp4
#ffmpeg -i video001.avi -r 10 -b:v 1M -c libx264 chunk1.mp4
#ffmpeg -i video002.avi -r 10 -b:v 1M -c libx264 chunk2.mp4

#ffmpeg -i in.mp4 -vf "drawtext=fontfile=/usr/share/fonts/truetype/DroidSans.ttf: timecode='09\:57\:00\:00': r=25: x=(w-tw)/2: y=h-(2*lh): fontcolor=white: box=1: boxcolor=0x00000000@1" -an -y out.mp4


# concatenate and speed up videos
#	create a temporary sped up video file
#	concat that with the current summary and put that in a new file (deleting the new file location if it already exists, so we don't error)
#	automatically? swap the new file and summary
#	delete the old file
#ffmpeg -f concat -i files2.txt -c copy concat1.mp4

#ffmpeg -i video002.avi -filter:v "setpts=PTS" -r 10 -b:v 1M -c libx264 chunk2.mp4