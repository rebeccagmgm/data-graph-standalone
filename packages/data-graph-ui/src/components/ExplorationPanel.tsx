import { useEffect, useState } from "react";
import type { Anchor } from "../types";
import type { ExplorationEntry, ExplorationMember } from "../exploration-entries";

type Props = {
  entries: ExplorationEntry[];
  activeEntryId?: string;
  currentAnchor?: Anchor;
  onCreate: (name: string, description: string) => void;
  onOpen: (entry: ExplorationEntry) => void;
  onOpenMember: (entry: ExplorationEntry, memberId: string) => void;
  onUpdate: (entry: ExplorationEntry, name: string, description: string) => void;
  onDelete: (entry: ExplorationEntry) => void;
  onAddCurrent: (entry: ExplorationEntry) => void;
  onRemoveMember: (entry: ExplorationEntry, member: ExplorationMember) => void;
  onSaveCurrent: (entry: ExplorationEntry) => void;
};

export function ExplorationPanel({
  entries,
  activeEntryId,
  currentAnchor,
  onCreate,
  onOpen,
  onOpenMember,
  onUpdate,
  onDelete,
  onAddCurrent,
  onRemoveMember,
  onSaveCurrent,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!creating && !editingId) {
      setName("");
      setDescription("");
    }
  }, [creating, editingId]);

  const currentMemberId = currentAnchor
    ? currentAnchor.taskId
      ? `task:${currentAnchor.taskId}`
      : currentAnchor.nodeId
        ? `node:${currentAnchor.nodeId}`
        : `table:${currentAnchor.table ?? currentAnchor.label}`
    : undefined;
  const active = entries.find((entry) => entry.id === activeEntryId);

  function startEdit(entry: ExplorationEntry) {
    setCreating(false);
    setEditingId(entry.id);
    setName(entry.name);
    setDescription(entry.description);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingId) {
      const entry = entries.find((item) => item.id === editingId);
      if (entry) onUpdate(entry, name, description);
      setEditingId(undefined);
      return;
    }
    onCreate(name, description);
    setCreating(false);
  }

  return (
    <section className="exploration-panel" aria-label="探索入口">
      <div className="exploration-title">
        <div>
          <p className="eyebrow">EXPLORATION ENTRIES</p>
          <h2>探索入口</h2>
        </div>
        <button
          type="button"
          className="exploration-create"
          disabled={!currentAnchor}
          title={currentAnchor ? "将当前画布保存为新专题" : "请先进入一个任务或表"}
          onClick={() => {
            setEditingId(undefined);
            setCreating((value) => !value);
          }}
        >
          + 保存当前
        </button>
      </div>
      <p className="exploration-hint">
        仅保存在当前浏览器；打开时按当前已发布图谱重新查询。
      </p>
      {(creating || editingId) && (
        <form className="exploration-form" onSubmit={submit}>
          <label>
            专题名称
            <input
              autoFocus
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：当事人 T01"
            />
          </label>
          <label>
            简短说明
            <input
              value={description}
              maxLength={160}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="例如：核对报表来源"
            />
          </label>
          <div className="exploration-form-actions">
            <button type="submit" className="primary">
              {editingId ? "保存修改" : "创建专题"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setEditingId(undefined);
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}
      <div className="exploration-list">
        {entries.length === 0 ? (
          <p className="exploration-empty">还没有保存的探索入口。</p>
        ) : (
          entries.map((entry) => {
            const isActive = entry.id === active?.id;
            const activeMember = entry.members.find(
              (member) => member.id === entry.state.activeMemberId,
            );
            return (
              <article
                className={`exploration-entry ${isActive ? "active" : ""}`}
                key={entry.id}
              >
                <div className="exploration-entry-heading">
                  <div>
                    <strong>{entry.name}</strong>
                    {entry.description && <small>{entry.description}</small>}
                  </div>
                  <button type="button" onClick={() => onOpen(entry)}>
                    打开
                  </button>
                </div>
                <p className="exploration-meta">
                  {entry.members.length} 个起点 · 保存于图谱 {entry.graphVersion.slice(0, 10)}
                </p>
                {isActive && (
                  <div className="exploration-active-tools">
                    <div className="exploration-members" aria-label={`${entry.name} 的起点`}>
                      {entry.members.map((member) => (
                        <div className="exploration-member" key={member.id}>
                          <button
                            type="button"
                            className={
                              member.id === entry.state.activeMemberId ? "selected" : ""
                            }
                            onClick={() => onOpenMember(entry, member.id)}
                            title={member.label}
                          >
                            {member.label}
                          </button>
                          {entry.members.length > 1 && (
                            <button
                              type="button"
                              className="exploration-remove-member"
                              aria-label={`移除 ${member.label}`}
                              onClick={() => onRemoveMember(entry, member)}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="exploration-entry-actions">
                      <button type="button" onClick={() => onSaveCurrent(entry)}>
                        更新当前状态
                      </button>
                      <button
                        type="button"
                        disabled={!currentAnchor || currentMemberId === activeMember?.id}
                        onClick={() => onAddCurrent(entry)}
                      >
                        加入当前起点
                      </button>
                      <button type="button" onClick={() => startEdit(entry)}>
                        改名/说明
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => setConfirmDeleteId(entry.id)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )}
                {confirmDeleteId === entry.id && (
                  <div className="exploration-delete-confirm">
                    <span>删除此专题及其保存的配置？</span>
                    <button type="button" className="danger" onClick={() => onDelete(entry)}>
                      确认删除
                    </button>
                    <button type="button" onClick={() => setConfirmDeleteId(undefined)}>
                      取消
                    </button>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
