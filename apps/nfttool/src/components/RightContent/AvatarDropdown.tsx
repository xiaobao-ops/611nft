import React from 'react';

export type GlobalHeaderRightProps = {
  menu?: boolean;
  children?: React.ReactNode;
};

/**
 * The platform has no account session. Keep this extension point render-safe
 * for layouts that opt into it, without showing a login/logout control.
 */
export const AvatarName = () => null;

export const AvatarDropdown: React.FC<GlobalHeaderRightProps> = ({ children }) => (
  <>{children}</>
);
