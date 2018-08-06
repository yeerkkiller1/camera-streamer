import * as React from "react";

interface IProps<T, M> {
    /** The user of this should this object, appending to the values every time a new value is added to.
     *      We mutate this array internally, so the parent shouldn't do anything but append to it.
    */
    valueHolder: T[];
    /** This is just any object that should change very time valueHolder is added to. */
    lastValue: {}|undefined;
    reduceFnc: (list: T[], prevValue: M|undefined) => M;

    onChange: (value: M|undefined) => void;
}
interface IState<T, M> {
    
}
export class PropsMapReduce<T, M> extends React.Component<IProps<T, M>, IState<T, M>> {
    state: IState<T, M> = { };
    value: M|undefined;
    private addValue(props: IProps<T, M>) {
        if(props.valueHolder.length === 0) {
            return;
        }
        let newValue = props.reduceFnc(props.valueHolder, this.value);
        props.valueHolder.splice(0, props.valueHolder.length);

        this.value = newValue;
        this.props.onChange(newValue);
    }
    componentWillMount() {
        this.addValue(this.props);
    }
    componentWillReceiveProps(nextProps: IProps<T, M>) {
        this.addValue(nextProps);
    }
    render() {
        return null
    }
}