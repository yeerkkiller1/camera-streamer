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

// Okay... we are basically there. BUT. Everything is way too slow...

wrapAsync(async () => {
    // We will make every chunk have consistent FPS, but it looks like different chunks can have different FPS, with no difficulty.
    //  Which is really useful, because we want the FPS to stay the same for a minimum period of time anyway, or else
    //  the video will look too choppy.
    // Then... expose this as a npm package, start faking video streaming to/in camera/streaming, and start saving, transcoding,
    //  and displaying the video in the browser.
    let buf = await CreateVideo({
        jpegPattern: "C:/Users/quent/Dropbox/camera/streaming/dist/videos/frame1.jpeg",
        //jpegPattern: "./dist/frame%d.jpeg",
        baseMediaDecodeTimeInSeconds: 0,
        fps: 10
    });

    writeFileSync("./dist/output1.mp4", buf);

    console.log(`Length ${buf.length}`);
});
//*/

/*
wrapAsync(async () => {
    testReadFile("C:/scratch/output.mp4");
});
*/

//todonext
// Actually... it looks like omxmjpegdec may work. So... let's spend another day trying to figure out how to use it,
//  as I think the parameters are the only thing preventing it from working.

// Oh... let's test the encoding power of the pi zero (with num-buffers and filesink). Which will be annoying
//  (it will require hdmi, and a keyboard), but will be very useful.

// Looks like there is no frame reordering... so this will work! And I think if we assume no reordering, certain
//  pps, pps, and frame orders and rates (and we specify the rate with periodicty-idr), we don't need any mp4-typescript parsing
//  in the main streamer/receiver code (besides start code checking, which is probably all [0,0,0,1] anyway) (so it will be fast).
//  /etc/ssh/sshd_config, PasswordAuthentication no
//  cat >> ~/.ssh/authorized_keys (put public key here)
//  2017-11-29-raspbian-stretch.img
//  gst-launch-1.0 version 1.10.4
//  GStreamer 1.10.4
//  http://packages.qa.debian.org/gstreamer1.0
// sudo apt install gstreamer-1.0
// sudo apt install gstreamer1.0-tools
// gst-inspect-1.0 omxh264enc
// time gst-launch-1.0 -vv -e v4l2src device=/dev/video0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable periodicty-idr=10 ! video/x-h264, profile=high ! tcpclientsink port=3000 host=192.168.0.202

// time gst-launch-1.0 -vv -e v4l2src device=/dev/video0 num-buffers=1 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! filesink location=test.jpeg

// time gst-launch-1.0 -vv -e multifilesrc location="raw%d.jpeg" ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! omxmjpegdec ! multifilesink location=raw%d.yuv

// time gst-launch-1.0 -vv -e filesrc location="raw0.jpeg" ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! omxmjpegdec ! filesink location=raw0.yuv

// time gst-launch-1.0 -vv -e v4l2src device=/dev/video0 num-buffers=30 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! multifilesink location=raw%d.jpeg

// time gst-launch-1.0 -vv -e v4l2src device=/dev/video0 num-buffers=90 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! omxmjpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable periodicty-idr=10 ! video/x-h264, profile=high ! filesink location=test.mp4