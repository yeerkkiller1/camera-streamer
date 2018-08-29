import * as React from "react";
import { isArray } from "../util/type";

interface IProps {
    onSizeChange: (size: { widthPx: number, heightPx: number }) => void;
}
interface IState {
    widthPx: number;
    heightPx: number;
}

export class MeasuredElement extends React.Component<IProps, IState> {
    state: IState = {
        widthPx: -1,
        heightPx: -1
    };
    _isMounted = false;
    componentDidMount() {
        this._isMounted = true;
        window.addEventListener("resize", this.onResize);
    }
    componentWillUnmount() {
        this._isMounted = false;
        window.removeEventListener("resize", this.onResize);
    }
    private lastElement: HTMLElement|undefined;
    private onResize = () => {
        let element = this.lastElement;
        if(!element) return;
        let { width, height } = element.getBoundingClientRect();
        if(this.state.widthPx !== width || this.state.heightPx !== height) {
            if(this._isMounted) {
                this.setState({ widthPx: width, heightPx: height });
            }
            this.props.onSizeChange({ widthPx: width, heightPx: height });
        }
    };

    private onRef = (element: HTMLElement|null) => {
        if(!element) return;
        this.lastElement = element;
        this.onResize();
    };
    public render() {
        let child = this.props.children;
        if(!child) {
            throw new Error(`Should have children`);
        }
        if(isArray(child)) {
            throw new Error(`Should not have multiple children`);
        }
        if(typeof child !== "object") {
            throw new Error(`Our child should be an object`);
        }
        if(!("type" in child && "props" in child && "key" in child)) {
            throw new Error(`Our child should be a ReactElement`);
        }
        let childCopy: React.ReactChild = { ...child };
        (childCopy as any)["ref"] = this.onRef;
        return childCopy;
    }
}