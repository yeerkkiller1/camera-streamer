import { g } from "pchannel";
g.NODE =  false;

import * as React from "react";
import * as ReactDOM from "react-dom";

// For polyfills
import "../util/math";
import { PlayerPage } from "./PlayerPage";

import "./main.less";

let rootElement = document.getElementById("root");
if(!rootElement) throw new Error("Missing root, at element with id=root");

render();
function render() {
    ReactDOM.render(
        <div>
            <div>
                <PlayerPage />
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