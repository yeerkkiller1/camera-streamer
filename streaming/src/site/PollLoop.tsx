import * as React from "react";

interface IProps {
    callback: () => Promise<void>|void;
    delay: number;
}
interface IState {

}

export class PollLoop extends React.Component<IProps, IState> {
    currentCallbackPromise: Promise<void>|void|undefined;
    closed = false;
    timeout: number|undefined;
    
    async doCall() {
        if(this.currentCallbackPromise || this.closed) return;
        try {
            this.currentCallbackPromise = this.props.callback();
        } catch(e) {
            console.error(`PollLoop callback threw, so we are stopping loop. ${this.props.callback.toString()}`);
            throw e;
        }
        if(this.currentCallbackPromise) {
            await this.currentCallbackPromise;
        }

        this.currentCallbackPromise = undefined;
        this.timeout = setTimeout(() => this.doCall(), this.props.delay) as any;
    }
    close() {
        this.closed = true;
        clearTimeout(this.timeout);
    }
    resetCall() {
        this.currentCallbackPromise = undefined;
        this.doCall();
    }

    componentWillMount() {
        //this.doCall();
    }
    componentDidMount() {
        this.doCall();
    }
    componentWillUnmount() {
        this.close();
    }

    
    componentDidUpdate(prevProps: IProps) {
        let delayFraction = this.props.delay / prevProps.delay;
        if(delayFraction < 0.5) {
            this.resetCall();
        }
    }

    render() {
        return null;
    }
}