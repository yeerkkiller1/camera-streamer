import { g } from "pchannel";
g.NODE =  false;

import * as React from "react";
import * as ReactDOM from "react-dom";

import "./main.less";
import { ConnectToServer } from "ws-class";

interface IState {
    url?: string;
}
class Main extends React.Component<{}, IState> {
    state: IState = {};

    vidStartTime: number|undefined;
    vidBuffer: SourceBuffer|undefined;


    componentWillMount() {
        let server = ConnectToServer<IHost>({
            port: 7060,
            host: "localhost",
            bidirectionController: this
        });

        server.subscribeToCamera();        
    }
    initVideo(vid: HTMLVideoElement|null) {
        if(!vid) return;
        var push = new MediaSource();
        vid.src = URL.createObjectURL(push);
        push.addEventListener("sourceopen", async () => {
            var buf = push.addSourceBuffer('video/mp4; codecs="avc1.640028"');
            this.vidBuffer = buf;

            buf.addEventListener("updateend", () => {
                console.log("Trying to play");
                vid.currentTime = this.vidStartTime || 0;
                vid.play();
            });
        });
    }

    acceptVideoSegment_VOID(info: VideoSegment): void {
        //todonext
        // Graph these times, so we can see lag happening
        //  - Then package up encoder into another package, encode the video, play it, and get statistics on that too.
        console.log(info);

        if(this.vidStartTime === undefined) {
            console.log("Init start time");
            this.vidStartTime = info.startTime;
            this.vidStartTime = 0;
        }

        if(this.vidBuffer) {
            console.log("Add buffer");
            this.vidBuffer.appendBuffer(info.mp4Video);
        }
    }

    render() {
        return (
            <div>
                <video width="1200" controls ref={x => this.initVideo(x)}></video>
            </div>
        );
    }
}


let rootElement = document.getElementById("root");
if(!rootElement) throw new Error("Missing root, at element with id=root");

render();
function render() {
    ReactDOM.render(
        <div>
            <div>
                <Main />
            </div>
        </div>,
        rootElement
    );
}

let moduleAny = module as any;

if (moduleAny.hot) {
    moduleAny.hot.accept("./site/CameraViewer.tsx", () => {
        debugger;
        render();
    });
}

/*
<video id="vid" controls></video>
<script>
    test();
    async function test() {
        var push = new MediaSource();
        var buf;
        vid.src = URL.createObjectURL(push);
        push.addEventListener("sourceopen", async () => {
            // TODO: Get this codec from the video file, so we know it is correct
            
            // I am not sure if the profile, compatibility and level even matter (the part after avc1.). Seems to work
            //  either way, which it should, because that info is in both the mp4 box, and the sps NAL unit.
            buf = push.addSourceBuffer('video/mp4; codecs="avc1.420029"');
            //buf = push.addSourceBuffer(`video/mp4; codecs="avc1.64001E"`);

            //let startTime = 38417943360 / 90000;
            //await addVideo("../youtube.mp4");

            let startTime = 100;
            //let startTime = 0;
            await addVideo("../dist/output0.mp4");
            await addVideo("../dist/output1.mp4");

            //let startTime = 20480 / 10240;
            //await addVideo("../10fps.dash_2.m4s");

            //await addVideo("../dist/output1.mp4");
            //await addVideo("../dist/output2.mp4");

            //let startTime = 200 * 10 / 1000;
            buf.addEventListener("updateend", () => {
                console.log("Trying to play");
                vid.currentTime = startTime;
                vid.play();

                console.log(buf.videoTracks);
            });
        });

        async function addVideo(path) {
            let result = await fetch(path);
            //let result = await fetch("./test.h264.mp4");
            let raw = await result.arrayBuffer();
            buf.appendBuffer(raw);
        }
    }
</script>
*/