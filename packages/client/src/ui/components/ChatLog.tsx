import React from 'react';
import { useChatLog } from '../../core/hooks';
import { nameToColor, hexToString } from '../../utils/color';
import { COLORS, FONTS } from '../styles';

interface ConversationGroup {
  conversationId: string;
  participants: string[];
  messages: { id: string; agentName: string; message: string; timestamp: number }[];
}

export const ChatLog: React.FC = () => {
  const chatLog = useChatLog();

  if (chatLog.length === 0) {
    return (
      <div
        style={{
          padding: 20,
          textAlign: 'center',
          fontFamily: FONTS.body,
          fontSize: '14px',
          color: COLORS.textDim,
        }}
      >
        Waiting for conversations...
      </div>
    );
  }

  // Group messages by conversationId
  const groups: ConversationGroup[] = [];
  const groupMap = new Map<string, ConversationGroup>();

  for (const entry of chatLog) {
    const key = entry.conversationId || entry.id;
    let group = groupMap.get(key);
    if (!group) {
      group = { conversationId: key, participants: [], messages: [] };
      groupMap.set(key, group);
      groups.push(group);
    }
    group.messages.push({
      id: entry.id,
      agentName: entry.agentName,
      message: entry.message,
      timestamp: entry.timestamp,
    });
    if (!group.participants.includes(entry.agentName)) {
      group.participants.push(entry.agentName);
    }
  }

  return (
    <div
      style={{
        padding: '4px 0',
        fontFamily: FONTS.body,
        fontSize: '14px',
      }}
    >
      {groups.map((group) => {
        const p1Color = group.participants[0]
          ? hexToString(nameToColor(group.participants[0]))
          : COLORS.textDim;
        const p2Color = group.participants[1]
          ? hexToString(nameToColor(group.participants[1]))
          : COLORS.textDim;

        return (
          <div
            key={group.conversationId}
            style={{
              margin: '6px 8px',
              borderRadius: 4,
              background: COLORS.bgCard,
              border: `1px solid ${COLORS.border}`,
              overflow: 'hidden',
            }}
          >
            {/* Conversation header */}
            <div
              style={{
                padding: '6px 10px',
                background: COLORS.bgHover,
                borderBottom: `1px solid ${COLORS.border}`,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span style={{ color: COLORS.gold, fontSize: '12px' }}>💬</span>
              <span style={{ color: p1Color, fontWeight: 'bold' }}>
                {group.participants[0] || '?'}
              </span>
              {group.participants[1] && (
                <>
                  <span style={{ color: COLORS.textDim }}>&</span>
                  <span style={{ color: p2Color, fontWeight: 'bold' }}>
                    {group.participants[1]}
                  </span>
                </>
              )}
            </div>

            {/* Messages */}
            {group.messages.map((msg) => {
              const color = hexToString(nameToColor(msg.agentName));
              return (
                <div
                  key={msg.id}
                  style={{
                    padding: '5px 10px',
                    borderBottom: `1px solid ${COLORS.border}22`,
                  }}
                >
                  <span style={{ color, fontWeight: 'bold', marginRight: 6 }}>
                    {msg.agentName}:
                  </span>
                  <span style={{ color: COLORS.text }}>
                    {msg.message}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
