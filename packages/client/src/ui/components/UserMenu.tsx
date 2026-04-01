import React, { useState, useEffect, useRef } from 'react';
import { getEmail, authHeaders, clearToken } from '../../utils/auth';
import { COLORS, FONTS } from '../styles';

interface UserMenuProps {
  onChangeMap: () => void;
  onLogout: () => void;
}

export const UserMenu: React.FC<UserMenuProps> = ({ onChangeMap, onLogout }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const email = getEmail();

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [open]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: authHeaders(),
      });
    } catch {
      // proceed with local logout even if server fails
    }
    clearToken();
    setOpen(false);
    onLogout();
  };

  const truncatedEmail = email
    ? email.length > 18
      ? email.slice(0, 15) + '...'
      : email
    : null;

  const menuItemStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    background: 'none',
    border: 'none',
    borderRadius: 0,
    fontFamily: FONTS.pixel,
    fontSize: 7,
    color: COLORS.text,
    cursor: 'pointer',
    textAlign: 'left',
    letterSpacing: 0.5,
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: COLORS.bg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 4,
          padding: '4px 8px',
          fontFamily: FONTS.pixel,
          fontSize: 7,
          color: COLORS.text,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {truncatedEmail || '\u2699'}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: '100%',
            marginTop: 4,
            zIndex: 50,
            background: COLORS.bg,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            minWidth: 180,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            overflow: 'hidden',
          }}
        >
          {/* Email display */}
          {email && (
            <div style={{
              padding: '8px 12px',
              fontFamily: FONTS.pixel,
              fontSize: 6,
              color: COLORS.textDim,
              borderBottom: `1px solid ${COLORS.border}`,
              wordBreak: 'break-all',
            }}>
              {email}
            </div>
          )}

          <button
            style={menuItemStyle}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = COLORS.bgHover; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none'; }}
            onClick={() => { setOpen(false); onChangeMap(); }}
          >
            Change Map
          </button>

          <button
            style={{ ...menuItemStyle, color: COLORS.warning }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = COLORS.bgHover; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none'; }}
            onClick={handleLogout}
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
};
