import * as React from "react";
import * as ReactDOM from "react-dom";
import { CameraViewer } from "./CameraViewer";

class Main extends React.Component<{}, {}> {
    render() {
        return (
            <CameraViewer />
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