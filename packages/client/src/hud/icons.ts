import { createElement, type IconNode } from 'lucide';

export const iconSvg = (icon: IconNode, size = 18): string => createElement(icon, {
  width: size, height: size, 'stroke-width': 2, 'aria-hidden': 'true', focusable: 'false',
}).outerHTML;
