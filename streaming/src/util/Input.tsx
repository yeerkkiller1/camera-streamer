import * as React from "react";

const localStoragePrefix = "Input_STORAGE_";

let values: {
    [key: string]: {}|undefined
} = {};
function getValue(key: string): {}|undefined {
    if(!(key in values)) {
        let value: {}|undefined = undefined;
        try {
            let str = localStorage.getItem(localStoragePrefix + key);
            if(str !== null) {
                value = JSON.parse(str);
            }
        } catch(e) { }
        values[key] = value;
    }

    return values[key];
}

export function setInputValue(globalKey: string, value: {}): void {
    values[globalKey] = value;
    localStorage.setItem(localStoragePrefix + globalKey, JSON.stringify(value));
}

export function getInitialCheckboxValue(globalKey: string): boolean {
    return getValue(globalKey) && true || false;
}

export function getIntialInputNumberValue(globalKey: string, initialValue: number): number {
    let number = getValue(globalKey) as any;
    if(number === undefined || isNaN(+number)) {
        values[globalKey] = initialValue;
    }
    return getValue(globalKey) as any;
}


interface ICheckboxProps {
    globalKey: string;
    indeterminate?: boolean;
    onValue: (value: boolean) => void;
}
interface ICheckboxState { }

export class Checkbox extends React.Component<ICheckboxProps, ICheckboxState> {
    state: ICheckboxState = { };

    checkbox: HTMLInputElement|null|undefined;

    componentDidMount() {
        this.afterUpdate();
    }
    componentDidUpdate() {
        this.afterUpdate();
    }
    afterUpdate() {
        if(this.checkbox) {
            this.checkbox.indeterminate = !!this.props.indeterminate;
        }
    }

    value(): boolean {
        return getValue(this.props.globalKey) && true || false;
    }

    public render() {
        return (
            <input
                type="checkbox"
                checked={this.value()}
                ref={x => this.checkbox = x}
                onChange={e => {
                    setInputValue(this.props.globalKey, e.currentTarget.checked);
                    this.props.onValue(this.value());
                }}
            />
        );
    }
}


interface IInputNumberProps {
    globalKey: string;
    onValue: (value: number) => void;
}
interface IInputNumberState { }
export class InputNumber extends React.Component<IInputNumberProps, IInputNumberState> {
    state: IInputNumberState = { };

    value(): number {
        let num = getValue(this.props.globalKey);
        return num === undefined || isNaN(num as any) ? undefined : num as any;
    }

    public render() {
        return (
            <input
                type="number"
                value={this.value()}
                onChange={e => {
                    setInputValue(this.props.globalKey, +e.currentTarget.value);
                    this.props.onValue(this.value());
                }}
            />
        );
    }
}