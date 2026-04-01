import React, { useState, useMemo } from 'react';
import { COLORS, FONTS } from '../styles';
import { nameToColor, hexToString } from '../../utils/color';
import { gameStore } from '../../core/GameStore';
import { useChatLog, useAgentsMap } from '../../core/hooks';
import type { ChatEntry } from '../../core/GameStore';

interface ConversationGroup {
  conversationId: string;
  participantNames: string[];
  messages: ChatEntry[];
}

export const GroupChat: React.FC<{ institutionId: string; memberIds: string[] }> = ({ memberIds }) => {
  const [expanded, setExpanded] = useState(false);
  const chatLog = useChatLog();
  const agentsMap = useAgentsMap();

  const memberSet = useMemo(() => new Set(memberIds), [memberIds]);

  const conversations = useMemo(() => {
    // Group messages by conversationId
    const groups = new Map<string, ChatEntry[]>();
    for (const entry of chatLog) {
      if (memberSet.has(entry.agentId)) {
        const existing = groups.get(entry.conversationId);
        if (existing) {
          existing.push(entry);
        } else {
          groups.set(entry.conversationId, [entry]);
        }
      }
    }

    // Filter: only conversations where ALL participants are members
    const result: ConversationGroup[] = [];
    for (const [conversationId, messages] of groups) {
      const participantIds = new Set(messages.map((m) => m.agentId));
      const allMembers = [...participantIds].every((id) => memberSet.has(id));
      if (!allMembers) continue;

      const participantNames = [...participantIds].map((id) => {
        const agent = agentsMap.get(id);
        return agent?.config.name ?? 'Unknown';
      });

      result.push({ conversationId, participantNames, messages: messages.slice(-20) });
    }

    // Sort by most recent message, take 5
    result.sort((a, b) => {
      const aTime = a.messages[a.messages.length - 1]?.timestamp ?? 0;
      const bTime = b.messages[b.messages.length - 1]?.timestamp ?? 0;
      return bTime - aTime;
    });

    return result.slice(0, 5);
  }, [chatLog, memberSet, agentsMap]);

  return (
    <div style={{ padding: '8px 0' }}>
      <div
        style={{
          fontFamily: FONTS.pixel,
          fontSize: 8,
          color: COLORS.textDim,
          letterSpacing: 2,
          cursor: 'pointer',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block', transition: 'transform 0.2s' }}>
          {'\u25B6'}
        </span>
        Group Conversations ({conversations.length})
      </div>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          {conversations.length === 0 ? (
            <div style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.textDim, fontStyle: 'italic' }}>
              No group conversations yet
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {conversations.map((conv) => (
                <div key={conv.conversationId} style={{ backgroundColor: COLORS.bgCard, borderRadius: 4, padding: 8 }}>
                  {/* Participant names header */}
                  <div style={{ fontFamily: FONTS.body, fontSize: 10, color: COLORS.textDim, marginBottom: 6 }}>
                    {conv.participantNames.join(', ')}
                  </div>

                  {/* Messages */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {conv.messages.map((msg) => (
                      <div key={msg.id} style={{ fontFamily: FONTS.body, fontSize: 11, color: COLORS.text }}>
                        <span
                          style={{ color: hexToString(nameToColor(msg.agentName)), cursor: 'pointer', fontWeight: 'bold' }}
                          onClick={() => gameStore.inspectAgent(msg.agentId)}
                        >
                          {msg.agentName}:
                        </span>{' '}
                        {msg.message}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
