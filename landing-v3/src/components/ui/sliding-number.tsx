"use client";
import { useEffect, useState } from "react";
import NumberFlow from "@number-flow/react";

type SlidingNumberProps = {
  value: number;
  duration?: number; // total duration of both animations (ms)
  className?: string;
};

const SlidingNumber = ({
  value,
  duration = 150,
  className = "text-4xl font-bold",
}: SlidingNumberProps) => {
  const [current, setCurrent] = useState(value);

  useEffect(() => {
    // Generate a single random value with the same digit length
    const digits = value.toString().length;
    const min = Math.pow(10, digits - 1);
    const max = Math.pow(10, digits) - 1;
    const randomValue = Math.floor(Math.random() * (max - min + 1)) + min;

    // Animate to random value
    setCurrent(randomValue);

    // Then back to original value after half the duration
    const timeout = setTimeout(() => {
      setCurrent(value);
    }, 30);

    return () => clearTimeout(timeout);
  }, [value, duration]);

  return (
    <NumberFlow
      value={current}
      trend={value > current ? -1 : 1}
      className={className}
    />
  );
};

export default SlidingNumber;
