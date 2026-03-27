import React, { useState } from 'react';
import { useBoard, useElections, useProperties, useInstitutions, useAgents, useWeather, useWorldTime } from '../../core/hooks';
import { COLORS, FONTS } from '../styles';
import { nameToColor, hexToString } from '../../utils/color';

const sectionLabel: React.CSSProperties = {
  color: COLORS.textAccent,
  marginBottom: 8,
  marginTop: 16,
  fontSize: '9px',
  fontFamily: FONTS.pixel,
  textTransform: 'uppercase',
  letterSpacing: 1,
};

const TYPE_STYLES: Record<string, { icon: string; color: string }> = {
  decree: { icon: '\u{1F451}', color: '#ff6b6b' },
  rule: { icon: '\u{2696}', color: '#fbbf24' },
  announcement: { icon: '\u{1F4E2}', color: '#60a5fa' },
  alliance: { icon: '\u{1F91D}', color: '#4ade80' },
  trade: { icon: '\u{1F4B1}', color: '#a78bfa' },
  news: { icon: '\u{1F4F0}', color: '#f472b6' },
  rumor: { icon: '\u{1F5E3}', color: '#fb923c' },
};

type SNSTab = 'all' | 'trades' | 'groups' | 'news';

export const VillageDashboard: React.FC = () => {
  const [snsTab, setSnsTab] = useState<SNSTab>('all');
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null);
  const board = useBoard();
  const elections = useElections();
  const properties = useProperties();
  const institutions = useInstitutions();
  const agents = useAgents();
  const weather = useWeather();
  const time = useWorldTime();

  const aliveAgents = agents.filter(a => a.alive !== false);

  // SNS filtering
  const allChat = board.filter(p =>
    (p.type === 'announcement' || p.type === 'rule')
    && (p.channel === 'all' || !p.channel) && !p.revoked
  );
  const trades = board.filter(p => p.type === 'trade' && !p.revoked);
  const groups = board.filter(p => p.channel === 'group' && !p.revoked);
  const news = board.filter(p => p.type === 'news' && !p.revoked);

  const activeElections = elections.filter(e => e.active);
  const pastElections = elections.filter(e => !e.active && e.winner);
  const activeInstitutions = institutions.filter(i => !i.dissolved);

  const renderPost = (post: typeof board[0]) => {
    const s = TYPE_STYLES[post.type] || TYPE_STYLES.announcement;
    const isRule = post.type === 'rule' && post.ruleStatus;
    const likeCount = post.votes?.filter(v => v.vote === 'like').length ?? 0;
    const dislikeCount = post.votes?.filter(v => v.vote === 'dislike').length ?? 0;

    const commentCount = post.comments?.length ?? 0;
    const isExpanded = expandedPostId === post.id;

    return (
      <div key={post.id} style={{
        marginBottom: 6,
        padding: '8px 10px',
        background: COLORS.bgCard,
        borderRadius: 4,
        borderLeft: `3px solid ${s.color}`,
        cursor: commentCount > 0 ? 'pointer' : 'default',
      }} onClick={() => {
        if (commentCount > 0) setExpandedPostId(isExpanded ? null : post.id);
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <span style={{ fontSize: '10px' }}>{s.icon}</span>
          <span style={{ color: s.color, textTransform: 'uppercase', fontSize: '9px', fontFamily: FONTS.pixel, letterSpacing: 1 }}>{post.type}</span>
          <span style={{ color: COLORS.textDim, fontSize: '11px' }}>by {post.authorName}</span>
          {commentCount > 0 && !isExpanded && (
            <span style={{ color: COLORS.textDim, fontSize: '9px', marginLeft: 'auto', fontFamily: FONTS.pixel }}>
              {commentCount} reaction{commentCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div style={{ color: COLORS.text, lineHeight: '1.5' }}>{post.content}</div>
        {isRule && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <span style={{
              fontSize: '10px',
              padding: '1px 6px',
              borderRadius: 3,
              background: post.ruleStatus === 'passed' ? '#4ade8030' : post.ruleStatus === 'rejected' ? '#ff6b6b30' : '#fbbf2430',
              color: post.ruleStatus === 'passed' ? '#4ade80' : post.ruleStatus === 'rejected' ? '#ff6b6b' : '#fbbf24',
              textTransform: 'uppercase',
              fontFamily: FONTS.pixel,
            }}>
              {post.ruleStatus}
            </span>
            {(likeCount > 0 || dislikeCount > 0) && (
              <span style={{ color: COLORS.textDim, fontSize: '10px' }}>
                {likeCount} for / {dislikeCount} against
              </span>
            )}
          </div>
        )}
        {isExpanded && post.comments && post.comments.length > 0 && (
          <div style={{ marginTop: 6, paddingTop: 4, borderTop: `1px solid rgba(255,255,255,0.06)` }}>
            {post.comments.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 2, alignItems: 'flex-start' }}>
                <span style={{
                  fontFamily: FONTS.pixel,
                  fontSize: '8px',
                  color: hexToString(nameToColor(c.agentName)),
                  flexShrink: 0,
                  paddingTop: 1,
                }}>
                  {c.agentName}
                </span>
                <span style={{
                  fontSize: '11px',
                  color: '#b0a0c0',
                  fontStyle: 'italic',
                  lineHeight: 1.3,
                }}>
                  {c.content}
                </span>
              </div>
            ))}
          </div>
        )}
        <div style={{ color: COLORS.textDim, fontSize: '10px', marginTop: 3 }}>Day {post.day}</div>
      </div>
    );
  };

  const tabStyle = (tab: SNSTab): React.CSSProperties => ({
    flex: 1,
    padding: '6px 4px',
    border: 'none',
    cursor: 'pointer',
    background: snsTab === tab ? COLORS.bgCard : 'transparent',
    color: snsTab === tab ? COLORS.textAccent : COLORS.textDim,
    fontFamily: FONTS.pixel,
    fontSize: '8px',
    borderBottom: snsTab === tab ? `2px solid ${COLORS.accent}` : '2px solid transparent',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  });

  const getTabPosts = () => {
    switch (snsTab) {
      case 'all': return allChat;
      case 'trades': return trades;
      case 'groups': return groups;
      case 'news': return news;
    }
  };

  const tabPosts = getTabPosts();

  return (
    <div style={{ padding: 12, fontFamily: FONTS.body, fontSize: '13px', color: COLORS.text }}>
      {/* Village Status */}
      <div style={sectionLabel}>VILLAGE STATUS</div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 6,
        marginBottom: 4,
      }}>
        <div style={{ padding: '8px 10px', background: COLORS.bgCard, borderRadius: 4, border: `1px solid ${COLORS.border}` }}>
          <div style={{ color: COLORS.textDim, fontSize: '10px', marginBottom: 2 }}>Population</div>
          <div style={{ fontFamily: FONTS.pixel, fontSize: '11px' }}>{aliveAgents.length} agents</div>
        </div>
        <div style={{ padding: '8px 10px', background: COLORS.bgCard, borderRadius: 4, border: `1px solid ${COLORS.border}` }}>
          <div style={{ color: COLORS.textDim, fontSize: '10px', marginBottom: 2 }}>Day / Season</div>
          <div style={{ fontFamily: FONTS.pixel, fontSize: '11px' }}>Day {time.day}, {weather.season}</div>
        </div>
        <div style={{ padding: '8px 10px', background: COLORS.bgCard, borderRadius: 4, border: `1px solid ${COLORS.border}` }}>
          <div style={{ color: COLORS.textDim, fontSize: '10px', marginBottom: 2 }}>Weather</div>
          <div style={{ fontFamily: FONTS.pixel, fontSize: '11px' }}>{weather.current} ({weather.temperature}°)</div>
        </div>
        <div style={{ padding: '8px 10px', background: COLORS.bgCard, borderRadius: 4, border: `1px solid ${COLORS.border}` }}>
          <div style={{ color: COLORS.textDim, fontSize: '10px', marginBottom: 2 }}>Time</div>
          <div style={{ fontFamily: FONTS.pixel, fontSize: '11px' }}>{time.hour}:{String(time.minute).padStart(2, '0')}</div>
        </div>
      </div>

      {/* Village Rules */}
      {(() => {
        const passedRules = board.filter(p => p.type === 'rule' && p.ruleStatus === 'passed' && !p.revoked);
        if (passedRules.length === 0) return null;
        return (
          <>
            <div style={sectionLabel}>VILLAGE RULES ({passedRules.length})</div>
            {passedRules.map(rule => {
              const likeCount = rule.votes?.filter(v => v.vote === 'like').length ?? 0;
              const dislikeCount = rule.votes?.filter(v => v.vote === 'dislike').length ?? 0;
              return (
                <div key={rule.id} style={{
                  padding: '6px 10px',
                  marginBottom: 3,
                  background: COLORS.bgCard,
                  borderRadius: 4,
                  borderLeft: '3px solid #4ade80',
                }}>
                  <div style={{ color: COLORS.text, fontSize: '12px', lineHeight: '1.4' }}>{rule.content}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 3 }}>
                    <span style={{ color: COLORS.textDim, fontSize: '10px' }}>by {rule.authorName}</span>
                    <span style={{ color: COLORS.textDim, fontSize: '10px' }}>Day {rule.day}</span>
                    <span style={{ color: '#4ade80', fontSize: '10px' }}>{likeCount}-{dislikeCount}</span>
                  </div>
                </div>
              );
            })}
          </>
        );
      })()}

      {/* Agent SNS */}
      <div style={sectionLabel}>AGENT SNS</div>
      <div style={{ display: 'flex', borderBottom: `1px solid ${COLORS.border}`, marginBottom: 8 }}>
        <button style={tabStyle('all')} onClick={() => setSnsTab('all')}>All Chat ({allChat.length})</button>
        <button style={tabStyle('trades')} onClick={() => setSnsTab('trades')}>Trades ({trades.length})</button>
        <button style={tabStyle('groups')} onClick={() => setSnsTab('groups')}>Groups ({groups.length})</button>
        <button style={tabStyle('news')} onClick={() => setSnsTab('news')}>News ({news.length})</button>
      </div>

      {tabPosts.length > 0 ? (
        [...tabPosts].reverse().slice(0, 20).map(renderPost)
      ) : (
        <div style={{ textAlign: 'center', color: COLORS.textDim, padding: '12px', fontSize: '11px' }}>
          No {snsTab === 'all' ? 'posts' : snsTab} yet.
        </div>
      )}

      {/* Elections */}
      {(activeElections.length > 0 || pastElections.length > 0) && (
        <>
          <div style={sectionLabel}>ELECTIONS</div>
          {activeElections.map(election => {
            const counts: Record<string, number> = {};
            for (const c of election.candidates) counts[c] = 0;
            for (const v of Object.values(election.votes) as string[]) counts[v] = (counts[v] || 0) + 1;
            const daysLeft = election.endDay - time.day;

            return (
              <div key={election.id} style={{
                background: COLORS.bgCard,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 4,
                padding: 10,
                marginBottom: 6,
              }}>
                <div style={{ color: '#fff', fontSize: '11px', marginBottom: 4, fontFamily: FONTS.pixel }}>
                  {'\u{1F5F3}\u{FE0F}'} {election.position}
                </div>
                {election.candidates.map((c: string) => {
                  const candidateAgent = agents.find(a => a.id === c);
                  return (
                    <div key={c} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', color: COLORS.text }}>
                      <span>{candidateAgent?.config.name ?? c.slice(0, 8)}</span>
                      <span style={{ color: COLORS.textDim }}>{counts[c] || 0} vote{(counts[c] || 0) !== 1 ? 's' : ''}</span>
                    </div>
                  );
                })}
                <div style={{ color: COLORS.idle, marginTop: 4, fontSize: '11px' }}>
                  {daysLeft > 0 ? `${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining` : 'Ending soon'}
                </div>
              </div>
            );
          })}
          {pastElections.slice(-3).reverse().map(e => {
            const winner = agents.find(a => a.id === e.winner);
            return (
              <div key={e.id} style={{
                padding: '6px 10px',
                marginBottom: 4,
                background: COLORS.bgCard,
                borderRadius: 4,
                border: `1px solid ${COLORS.border}`,
                opacity: 0.7,
              }}>
                <span style={{ color: COLORS.textDim, fontSize: '11px' }}>{e.position}: </span>
                <span style={{ color: COLORS.active, fontSize: '11px' }}>{winner?.config.name ?? 'unknown'} won</span>
              </div>
            );
          })}
        </>
      )}

      {/* Properties */}
      {properties.length > 0 && (
        <>
          <div style={sectionLabel}>PROPERTIES ({properties.length})</div>
          {properties.map(p => {
            const owner = agents.find(a => a.id === p.ownerId);
            return (
              <div key={p.areaId} style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '6px 10px',
                marginBottom: 3,
                background: COLORS.bgCard,
                borderRadius: 4,
                border: `1px solid ${COLORS.border}`,
              }}>
                <span style={{ color: COLORS.text, fontSize: '12px' }}>{p.areaId}</span>
                <span style={{ color: COLORS.textDim, fontSize: '12px' }}>{owner?.config.name ?? p.ownerId.slice(0, 8)}</span>
              </div>
            );
          })}
        </>
      )}

      {/* Institutions */}
      {activeInstitutions.length > 0 && (
        <>
          <div style={sectionLabel}>INSTITUTIONS ({activeInstitutions.length})</div>
          {activeInstitutions.map(inst => (
            <div key={inst.id} style={{
              padding: '8px 10px',
              marginBottom: 6,
              background: COLORS.bgCard,
              borderRadius: 4,
              border: `1px solid ${COLORS.border}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: COLORS.text, fontSize: '12px', fontWeight: 'bold' }}>{inst.name}</span>
                <span style={{ color: COLORS.textDim, fontSize: '10px' }}>{inst.type}</span>
              </div>
              {inst.description && (
                <div style={{ color: COLORS.textDim, fontSize: '11px', marginBottom: 4, lineHeight: '1.4' }}>{inst.description}</div>
              )}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {inst.members.map(m => {
                  const member = agents.find(a => a.id === m.agentId);
                  return (
                    <span key={m.agentId} style={{
                      fontSize: '10px',
                      padding: '2px 6px',
                      borderRadius: 3,
                      background: m.role === 'founder' ? COLORS.accent + '30' : COLORS.border,
                      color: m.role === 'founder' ? COLORS.accent : COLORS.textDim,
                    }}>
                      {member?.config.name ?? m.agentId.slice(0, 8)} ({m.role})
                    </span>
                  );
                })}
              </div>
              {inst.treasury > 0 && (
                <div style={{ color: COLORS.textDim, fontSize: '10px', marginTop: 4 }}>Has treasury</div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
};
