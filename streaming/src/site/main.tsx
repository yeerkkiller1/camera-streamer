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
    componentWillMount() {
        let server = ConnectToServer<IHost>({
            port: 7060,
            host: "localhost",
            bidirectionController: this
        });

        server.subscribeToWebcamFrameInfo();
    }

    acceptWebcamFrameInfo_VOID(info: WebcamFrameInfo): void {
        //todonext
        // Graph these times, so we can see lag happening
        //  - Then package up encoder into another package, encode the video, play it, and get statistics on that too.
        console.log(info);
    }

    render() {
        let { url } = this.state;
        return (
            <div>
                { url }
                <img src={url} />
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