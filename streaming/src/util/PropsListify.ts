import * as React from "react";

interface IProps<T> {
    value: T;
    listSize: number;
    renderFnc: (list: T[]) => JSX.Element;
}
interface IState<T> {
    list: T[];
}
export class PropsListify<T> extends React.Component<IProps<T>, IState<T>> {
    state: IState<T> = {
        list: []
    };
    private addValue(props: IProps<T>) {
        let list = this.state.list;
        list.push(props.value);
        let extraValues = list.length - this.props.listSize;
        if(extraValues > 0) {
            list.splice(0, extraValues);
        }
        this.setState({ list });
    }
    componentWillMount() {
        this.addValue(this.props);
    }
    componentWillReceiveProps(nextProps: IProps<T>) {
        this.addValue(nextProps);
    }
    render() {
        return this.props.renderFnc(this.state.list);
    }
}