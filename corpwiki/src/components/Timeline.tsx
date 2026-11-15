import React from "react";
import "./Timeline.css";

interface TimelineItemProps {
    date: string;
    title: string;
    description: string;
    icon?: React.ReactNode;
    color?: string;
    isLeft?: boolean;
}

const TimelineItem: React.FC<TimelineItemProps> = ({
    date,
    title,
    description,
    icon,
    color = "#3b82f6",
    isLeft,
}) => {
    return (
        <div className={`timeline-item ${isLeft ? "left" : "right"}`}>
            <div className="timeline-marker" style={{ backgroundColor: color }}>
                {icon}
            </div>
            <div className="timeline-content">
                <span className="timeline-date" style={{ color: color }}>
                    {date}
                </span>
                <h3>{title}</h3>
                <p>{description}</p>
            </div>
        </div>
    );
};

interface TimelineProps {
    children: React.ReactNode;
}

export const Timeline: React.FC<TimelineProps> & {
    Item: typeof TimelineItem;
} = ({ children }) => {
    return (
        <div className="timeline-container">
            <div className="timeline-line"></div>
            {React.Children.map(children, (child, index) => {
                if (React.isValidElement(child)) {
                    return React.cloneElement(
                        child as React.ReactElement<any>,
                        {
                            isLeft: index % 2 === 0,
                        },
                    );
                }
                return child;
            })}
        </div>
    );
};

Timeline.Item = TimelineItem;
