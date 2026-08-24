import { PointerSensor, TouchSensor } from '@dnd-kit/core';
import type { PointerEvent, TouchEvent } from 'react';

/** Buttons, fields, and [data-no-dnd] must never start a sample drag. */
export function isNoDndEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(
    'button, a, input, textarea, select, label, [data-no-dnd]'
  );
}

export class NonInteractivePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent }: PointerEvent) => {
        if (!nativeEvent.isPrimary || nativeEvent.button !== 0) return false;
        if (isNoDndEventTarget(nativeEvent.target)) return false;
        return true;
      },
    },
  ];
}

export class NonInteractiveTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: 'onTouchStart' as const,
      handler: ({ nativeEvent }: TouchEvent) => {
        if (isNoDndEventTarget(nativeEvent.target)) return false;
        return true;
      },
    },
  ];
}
