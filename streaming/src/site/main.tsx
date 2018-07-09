import { g } from "../misc";
g.NODE =  false;

import * as React from "react";
import * as ReactDOM from "react-dom";

import "./main.less";
import { ConnectToServer } from "ws-class";

g.NODE = false;

interface IState {
    url?: string;
}
class Main extends React.Component<{}, IState> {
    state: IState = {};
    componentWillMount() {
        let server = ConnectToServer<IHost>({
            port: 7060,
            host: "localhost"
        });

        let component = this;
        setTimeout(async function getFrame(){
            let frame = await server.testGetLastFrame();
            if(frame !== null) {
                let blob = new Blob([frame], { type: "image/jpeg" });
                let url = URL.createObjectURL(blob);

                component.setState({ url });
            }

            setTimeout(getFrame, 1000);
        }, 1000);
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