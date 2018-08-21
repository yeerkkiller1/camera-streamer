import * as React from "react";

interface IProps {
    button: JSX.Element;
    onClick: () => void;
    hoverClassName: string;
}
interface IState {
    mouseOver: boolean;
    justClicked: boolean;
}

export class ClickAnim extends React.Component<IProps, IState> {
    state: IState = {
        mouseOver: false,
        justClicked: false
    };
    public render() {
        let { button, onClick, hoverClassName } = this.props;
        let { mouseOver, justClicked } = this.state;

        button = { ...button };
        button.props = { ...button.props };

        if(mouseOver && !justClicked) {
            button.props.className += " " + hoverClassName;
        }
        button.props.onClick = (e: React.MouseEvent<HTMLElement>) => {
            if(e.button !== 0) return;
            this.setState({ justClicked: true });
            onClick();
        };
        button.props.onMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
            this.setState({ mouseOver: true });
        };
        button.props.onMouseOut = (e: React.MouseEvent<HTMLElement>) => {
            this.setState({ mouseOver: false });
            this.setState({ justClicked: false });
        };

        return button;
    }
}