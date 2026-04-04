import React from 'react';
import type { ChatEntry } from '../../core/GameStore';
import { nameToColor, hexToString } from '../../utils/color';
import { FONTS } from '../styles';
import { useTheme } from '../ThemeContext';

interface ConversationExpanderProps {
  conversationId: string;
  chatLog: ChatEntry[];
}

export const ConversationExpander: React.FC<ConversationExpanderProps> = ({
  conversationId,
  chatLog,
}) => {
  const { colors } = useTheme();
  const messages = chatLog.filter(e => e.conversationId === conversationId);

  if (messages.length === 0) {
    return (
      <div style={{ fontSize: '11px', color: colors.textDim, fontFamily: FONTS.body, marginTop: 8 }}>
        No conversation found.
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: 8,
        background: colors.bgLight,
        borderRadius: 4,
        padding: 8,
        maxHeight: 200,
        overflowY: 'auto',
        fontFamily: FONTS.body,
        fontSize: '12px',
      }}
    >
      {messages.map(msg => {
        const color = hexToString(nameToColor(msg.agentName));
        return (
          <div key={msg.id} style={{ padding: '3px 0', borderBottom: `1px solid ${colors.border}22` }}>
            <span style={{ color, fontWeight: 'bold', marginRight: 6 }}>
              {msg.agentName}:
            </span>
            <span style={{ color: colors.text }}>{msg.message}</span>
          </div>
        );
      })}
    </div>
  );
};
