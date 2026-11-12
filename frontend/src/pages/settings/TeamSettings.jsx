import { useCallback, useEffect, useId, useState } from 'react'
import PageHeader from '../../components/PageHeader'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import SettingsNav from '../../components/SettingsNav'
import TeamDialog from './TeamDialog'
import { useCompany } from '../../hooks/useCompany'
import { useProfile } from '../../hooks/useProfile'
import { useTeam } from '../../hooks/useTeam'
import { formatRole, formatIsoDate } from '../../lib/formatters'
import {
  TEAM_ROLES, canManageTeam, canEditMember, inviteStatusBadge, deliveryBadge, memberStatusBadge, fileLinkNote,
  teamErrorMessage, INVITE_STATUS, MEMBER_STATUS,
} from '../../lib/team'

// ── Company Settings → Team (ADR-72) ─────────────────────────────────────────
//
// Members, roles and invitations, for company_admin only. Every action is a
// callable on the trusted backend; the page holds no Firestore listener and
// refreshes by calling listTeam again after each action. Non-admins see a
// read-only notice — the backend refuses them anyway (`not-admin`).

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none min-h-[44px]'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'
const tdCls    = 'px-3.5 py-3 text-[12.5px] text-brand-text align-top border-t border-brand-border'

const RESENDABLE = [INVITE_STATUS.PENDING, INVITE_STATUS.EXPIRED, INVITE_STATUS.LOCKED]

function Notice({ notice, onDismiss }) {
  if (!notice) return null
  const tone = notice.kind === 'error'
    ? 'bg-brand-red/10 border-brand-red/40 text-brand-red'
    : notice.kind === 'warning'
      ? 'bg-brand-amber/10 border-brand-amber/40 text-brand-amber'
      : 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent'
  return (
    <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-xs mb-3.5 ${tone}`}>
      <span className="leading-normal">{notice.text}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="min-w-[32px] min-h-[24px] -mr-1 -my-1 opacity-80 hover:opacity-100">✕</button>
    </div>
  )
}

// ADR-74: whether links this person may have copied earlier are revoked yet.
// A background clean-up reported by the backend — never shown as immediate.
const FILE_LINK_TONE = { muted: 'text-brand-muted', pending: 'text-brand-muted', warning: 'text-brand-amber' }

function FileLinkNote({ member }) {
  const note = fileLinkNote(member)
  if (!note) return null
  return <span className={`block text-[11px] mt-1 ${FILE_LINK_TONE[note.tone]}`}>{note.text}</span>
}

function RoleSelect({ id, value, onChange, disabled }) {
  return (
    <select id={id} className={inputCls} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
      {TEAM_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
    </select>
  )
}

export default function TeamSettings() {
  const { company, companyLoading } = useCompany()
  const { profile, profileLoading } = useProfile()
  const team = useTeam()
  const uid = useId()

  const isAdmin = canManageTeam(profile?.role)

  const [state, setState]   = useState({ phase: 'idle', data: null, message: '' })
  const [notice, setNotice] = useState(null)
  const [dialog, setDialog] = useState(null)       // { type, member?, invite? }
  const [dialogError, setDialogError] = useState('')
  const [busy, setBusy]     = useState(false)
  const [resending, setResending] = useState(null)

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole]   = useState('project_manager')
  // Role form
  const [newRole, setNewRole] = useState('project_manager')

  const load = useCallback(() =>
    team.listTeam({})
      .then(data => setState({ phase: 'ready', data, message: '' }))
      .catch(err => setState(s => ({ phase: 'error', data: s.data, message: teamErrorMessage(err) }))),
  [team])

  useEffect(() => {
    if (!isAdmin) return undefined
    load()
    return undefined
  }, [isAdmin, load])

  function openDialog(next) {
    setDialogError('')
    if (next.type === 'invite') { setInviteEmail(''); setInviteRole('project_manager') }
    if (next.type === 'role') setNewRole(next.member.role)
    setDialog(next)
  }
  const closeDialog = () => { if (!busy) { setDialog(null); setDialogError('') } }

  // Runs one backend action: closes the dialog and posts a notice on success,
  // keeps the dialog open with the message on failure, refreshes either way
  // when something may have changed.
  async function run(action, onSuccess) {
    setBusy(true); setDialogError(''); setNotice(null)
    try {
      const res = await action()
      setDialog(null)
      setNotice(onSuccess(res))
      await load()
    } catch (err) {
      const text = teamErrorMessage(err)
      if (dialog) setDialogError(text); else setNotice({ kind: 'error', text })
    } finally {
      setBusy(false)
    }
  }

  const inviteResultNotice = (res) => res.delivery === 'sent'
    ? { kind: 'success', text: `Invitation sent to ${res.email}. It expires on ${formatIsoDate(res.expiresAt)}.` }
    : res.delivery === 'operator'
      ? { kind: 'warning', text: `Invitation for ${res.email} saved for operator delivery.` }
      : { kind: 'warning', text: `The invitation for ${res.email} was saved but the email was not delivered. Use Resend once email delivery is configured.` }

  async function onResend(invite) {
    setResending(invite.inviteId); setNotice(null)
    try {
      const res = await team.resendInvitation({ inviteId: invite.inviteId })
      setNotice(inviteResultNotice(res))
      await load()
    } catch (err) {
      setNotice({ kind: 'error', text: teamErrorMessage(err) })
    } finally {
      setResending(null)
    }
  }

  if (companyLoading || profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading company…</div>
  }

  const members = state.data?.members ?? []
  const invitations = state.data?.invitations ?? []
  const activeCount = members.filter(m => m.status === MEMBER_STATUS.ACTIVE).length

  return (
    <div className="max-w-[1280px]">
      <PageHeader title="Team" sub={company?.name ? `${company.name} · members & invitations` : 'Members & invitations'}>
        {isAdmin && <Btn onClick={() => openDialog({ type: 'invite' })}>Invite member</Btn>}
      </PageHeader>

      <SettingsNav />

      {!isAdmin ? (
        <Card>
          <p className="text-[13px] text-brand-text font-semibold m-0">The team is managed by a Company Admin</p>
          <p className="text-[12.5px] text-brand-muted m-0 mt-1">
            Only the Company Admin role can invite members, change roles or deactivate accounts. The trusted backend
            enforces this on every request.
          </p>
        </Card>
      ) : (
        <>
          <Notice notice={notice} onDismiss={() => setNotice(null)} />

          {state.phase === 'error' && (
            <div role="alert" className="rounded-lg border border-brand-red/40 bg-brand-red/10 text-brand-red px-3.5 py-2.5 text-xs mb-3.5 flex items-center justify-between gap-3">
              <span>{state.message}</span>
              <Btn sm variant="ghost" onClick={load}>Retry</Btn>
            </div>
          )}

          {/* ── Members ───────────────────────────────────────────────── */}
          <Card className="mb-3.5" padding={false}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
              <p className="text-[13px] font-bold text-brand-text m-0">
                Members {state.data && <span className="font-normal text-brand-muted">· {activeCount} active</span>}
              </p>
            </div>

            {state.phase === 'idle' || (state.phase === 'error' && !state.data) ? (
              <p className="px-5 py-6 text-[13px] text-brand-muted m-0">{state.phase === 'idle' ? 'Loading team…' : 'Team unavailable.'}</p>
            ) : members.length === 0 ? (
              <p className="px-5 py-6 text-[13px] text-brand-muted m-0">No members yet.</p>
            ) : (
              <>
                {/* Desktop */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full min-w-[720px] border-collapse">
                    <thead>
                      <tr>
                        <th className={thCls}>Member</th>
                        <th className={thCls}>Role</th>
                        <th className={thCls}>Status</th>
                        <th className={thCls}>Last sign-in</th>
                        <th className={`${thCls} text-right`}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map(m => {
                        const status = memberStatusBadge(m)
                        return (
                          <tr key={m.uid}>
                            <td className={tdCls}>
                              <span className="font-semibold">{m.name || m.email || m.uid}</span>
                              {m.isSelf && <span className="ml-1.5 text-[11px] text-brand-muted">(you)</span>}
                              {m.email && m.name && <span className="block text-[11.5px] text-brand-muted">{m.email}</span>}
                            </td>
                            <td className={tdCls}>
                              {formatRole(m.role)}
                              {m.managed === 'operator' && <span className="block text-[11px] text-brand-muted">Managed by operator</span>}
                            </td>
                            <td className={tdCls}>
                              <Badge label={status.label} variant={status.variant} sm />
                              <FileLinkNote member={m} />
                            </td>
                            <td className={tdCls}>{m.lastSignInAt ? formatIsoDate(m.lastSignInAt) : '—'}</td>
                            <td className={`${tdCls} text-right whitespace-nowrap`}>
                              {canEditMember(m) && (
                                <>
                                  <Btn sm variant="ghost" onClick={() => openDialog({ type: 'role', member: m })}>Change role</Btn>
                                  <Btn sm variant="ghost" className="ml-2 text-brand-red" onClick={() => openDialog({ type: 'deactivate', member: m })}>Deactivate</Btn>
                                </>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {/* Mobile */}
                <ul className="md:hidden divide-y divide-brand-border m-0 p-0 list-none">
                  {members.map(m => {
                    const status = memberStatusBadge(m)
                    return (
                      <li key={m.uid} className="px-5 py-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[13px] font-semibold text-brand-text m-0 truncate">{m.name || m.email || m.uid}{m.isSelf && <span className="ml-1.5 text-[11px] font-normal text-brand-muted">(you)</span>}</p>
                            {m.email && <p className="text-[11.5px] text-brand-muted m-0 truncate">{m.email}</p>}
                            <p className="text-[12px] text-brand-text m-0 mt-1">{formatRole(m.role)}{m.managed === 'operator' && <span className="text-brand-muted"> · managed by operator</span>}</p>
                            <FileLinkNote member={m} />
                          </div>
                          <Badge label={status.label} variant={status.variant} sm />
                        </div>
                        {canEditMember(m) && (
                          <div className="flex gap-2 mt-3">
                            <Btn sm variant="ghost" onClick={() => openDialog({ type: 'role', member: m })}>Change role</Btn>
                            <Btn sm variant="ghost" className="text-brand-red" onClick={() => openDialog({ type: 'deactivate', member: m })}>Deactivate</Btn>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </Card>

          {/* ── Pending invitations ───────────────────────────────────── */}
          <Card padding={false}>
            <div className="px-5 py-4 border-b border-brand-border">
              <p className="text-[13px] font-bold text-brand-text m-0">Pending invitations</p>
            </div>
            {state.phase === 'idle' ? (
              <p className="px-5 py-6 text-[13px] text-brand-muted m-0">Loading…</p>
            ) : invitations.length === 0 ? (
              <p className="px-5 py-6 text-[13px] text-brand-muted m-0">No pending invitations.</p>
            ) : (
              <>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full min-w-[720px] border-collapse">
                    <thead>
                      <tr>
                        <th className={thCls}>Email</th>
                        <th className={thCls}>Role</th>
                        <th className={thCls}>Status</th>
                        <th className={thCls}>Delivery</th>
                        <th className={thCls}>Expires</th>
                        <th className={`${thCls} text-right`}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invitations.map(inv => {
                        const st = inviteStatusBadge(inv.status)
                        const dl = deliveryBadge(inv.delivery)
                        return (
                          <tr key={inv.inviteId}>
                            <td className={`${tdCls} font-semibold`}>{inv.email}</td>
                            <td className={tdCls}>{formatRole(inv.role)}</td>
                            <td className={tdCls}><Badge label={st.label} variant={st.variant} sm /></td>
                            <td className={tdCls}><Badge label={dl.label} variant={dl.variant} sm /></td>
                            <td className={tdCls}>{formatIsoDate(inv.expiresAt)}</td>
                            <td className={`${tdCls} text-right whitespace-nowrap`}>
                              {RESENDABLE.includes(inv.status) && (
                                <Btn sm variant="ghost" disabled={resending === inv.inviteId} onClick={() => onResend(inv)}>
                                  {resending === inv.inviteId ? 'Sending…' : 'Resend'}
                                </Btn>
                              )}
                              <Btn sm variant="ghost" className="ml-2 text-brand-red" onClick={() => openDialog({ type: 'revoke', invite: inv })}>Revoke</Btn>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <ul className="md:hidden divide-y divide-brand-border m-0 p-0 list-none">
                  {invitations.map(inv => {
                    const st = inviteStatusBadge(inv.status)
                    const dl = deliveryBadge(inv.delivery)
                    return (
                      <li key={inv.inviteId} className="px-5 py-4">
                        <p className="text-[13px] font-semibold text-brand-text m-0 break-all">{inv.email}</p>
                        <p className="text-[12px] text-brand-text m-0 mt-1">{formatRole(inv.role)} · expires {formatIsoDate(inv.expiresAt)}</p>
                        <div className="flex flex-wrap gap-2 mt-2">
                          <Badge label={st.label} variant={st.variant} sm />
                          <Badge label={dl.label} variant={dl.variant} sm />
                        </div>
                        <div className="flex gap-2 mt-3">
                          {RESENDABLE.includes(inv.status) && (
                            <Btn sm variant="ghost" disabled={resending === inv.inviteId} onClick={() => onResend(inv)}>
                              {resending === inv.inviteId ? 'Sending…' : 'Resend'}
                            </Btn>
                          )}
                          <Btn sm variant="ghost" className="text-brand-red" onClick={() => openDialog({ type: 'revoke', invite: inv })}>Revoke</Btn>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
            <p className="px-5 py-3 text-[11px] text-brand-muted m-0 border-t border-brand-border">
              Invitations expire after 7 days. Resending issues a new link and invalidates the old one.
            </p>
          </Card>
        </>
      )}

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}
      {dialog?.type === 'invite' && (
        <TeamDialog title="Invite a team member" titleId={`${uid}-invite-title`} onClose={closeDialog} busy={busy}>
          <form onSubmit={(e) => { e.preventDefault(); run(() => team.createInvitation({ email: inviteEmail.trim(), role: inviteRole }), inviteResultNotice) }}>
            <div className="space-y-3.5">
              <div>
                <label htmlFor={`${uid}-invite-email`} className={labelCls}>Email <span className="text-brand-red">*</span></label>
                <input id={`${uid}-invite-email`} type="email" required autoFocus autoComplete="off" className={inputCls} value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="name@company.com" />
              </div>
              <div>
                <label htmlFor={`${uid}-invite-role`} className={labelCls}>Role <span className="text-brand-red">*</span></label>
                <RoleSelect id={`${uid}-invite-role`} value={inviteRole} onChange={setInviteRole} disabled={busy} />
                <p className="text-[11px] text-brand-muted m-0 mt-1.5">{TEAM_ROLES.find(r => r.value === inviteRole)?.hint}</p>
              </div>
            </div>
            {dialogError && <p role="alert" className="text-xs text-brand-red mt-3 mb-0">{dialogError}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <Btn type="button" variant="ghost" onClick={closeDialog} disabled={busy}>Cancel</Btn>
              <Btn type="submit" disabled={busy || !inviteEmail.trim()}>{busy ? 'Sending…' : 'Send invitation'}</Btn>
            </div>
          </form>
        </TeamDialog>
      )}

      {dialog?.type === 'role' && (
        <TeamDialog title="Change role" titleId={`${uid}-role-title`} onClose={closeDialog} busy={busy}>
          <form onSubmit={(e) => { e.preventDefault(); run(
            () => team.changeMemberRole({ uid: dialog.member.uid, role: newRole, expectedRole: dialog.member.role }),
            (res) => ({ kind: 'success', text: res.changed ? `${dialog.member.name || dialog.member.email} is now ${formatRole(res.role)}.` : 'No change — that role was already set.' }),
          ) }}>
            <p className="text-[13px] text-brand-text m-0 mb-3">
              <span className="font-semibold">{dialog.member.name || dialog.member.email}</span> is currently <span className="font-semibold">{formatRole(dialog.member.role)}</span>.
            </p>
            <label htmlFor={`${uid}-new-role`} className={labelCls}>New role</label>
            <RoleSelect id={`${uid}-new-role`} value={newRole} onChange={setNewRole} disabled={busy} />
            <p className="text-[11px] text-brand-muted m-0 mt-1.5">{TEAM_ROLES.find(r => r.value === newRole)?.hint}</p>
            {dialog.member.role === 'company_admin' && newRole !== 'company_admin' && (
              <p className="text-[11px] text-brand-amber m-0 mt-2">A company must keep at least one active Company Admin; the change is refused if this is the last one.</p>
            )}
            {dialogError && <p role="alert" className="text-xs text-brand-red mt-3 mb-0">{dialogError}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <Btn type="button" variant="ghost" onClick={closeDialog} disabled={busy}>Cancel</Btn>
              <Btn type="submit" disabled={busy || newRole === dialog.member.role}>{busy ? 'Saving…' : 'Change role'}</Btn>
            </div>
          </form>
        </TeamDialog>
      )}

      {dialog?.type === 'deactivate' && (
        <TeamDialog title="Deactivate member" titleId={`${uid}-deactivate-title`} onClose={closeDialog} busy={busy}>
          <p className="text-[13px] text-brand-text m-0 mb-2">
            Deactivate <span className="font-semibold">{dialog.member.name || dialog.member.email}</span>?
          </p>
          <ul className="text-[12px] text-brand-text-soft m-0 mb-3 pl-4 space-y-1">
            <li>Their membership is removed immediately — every new request is denied.</li>
            <li>Their sign-in is disabled and their sessions are revoked.</li>
            <li>File links they may have copied earlier are revoked by a background clean-up, not straight away. This page shows when it has finished.</li>
            <li>Their history, approvals and audit records are kept.</li>
            <li>You can invite them again later; they keep the same account.</li>
          </ul>
          {dialog.member.role === 'company_admin' && (
            <p className="text-[11px] text-brand-amber m-0 mb-2">A company must keep at least one active Company Admin; this is refused if they are the last one.</p>
          )}
          {dialogError && <p role="alert" className="text-xs text-brand-red mt-3 mb-0">{dialogError}</p>}
          <div className="flex justify-end gap-2 mt-5">
            <Btn type="button" variant="ghost" onClick={closeDialog} disabled={busy}>Cancel</Btn>
            <Btn type="button" variant="danger" disabled={busy} onClick={() => run(
              () => team.deactivateMember({ uid: dialog.member.uid }),
              (res) => res.authSynced
                ? { kind: 'success', text: `${dialog.member.name || dialog.member.email} was deactivated. Old file links are being revoked in the background.` }
                : { kind: 'warning', text: `${dialog.member.name || dialog.member.email} was deactivated, but disabling their sign-in did not complete. Run Deactivate again to finish.` },
            )}>{busy ? 'Deactivating…' : 'Deactivate'}</Btn>
          </div>
        </TeamDialog>
      )}

      {dialog?.type === 'revoke' && (
        <TeamDialog title="Revoke invitation" titleId={`${uid}-revoke-title`} onClose={closeDialog} busy={busy}>
          <p className="text-[13px] text-brand-text m-0 mb-3">
            Revoke the invitation for <span className="font-semibold">{dialog.invite.email}</span>? The link they received will stop working.
          </p>
          {dialogError && <p role="alert" className="text-xs text-brand-red mt-3 mb-0">{dialogError}</p>}
          <div className="flex justify-end gap-2 mt-5">
            <Btn type="button" variant="ghost" onClick={closeDialog} disabled={busy}>Cancel</Btn>
            <Btn type="button" variant="danger" disabled={busy} onClick={() => run(
              () => team.revokeInvitation({ inviteId: dialog.invite.inviteId }),
              () => ({ kind: 'success', text: `Invitation for ${dialog.invite.email} revoked.` }),
            )}>{busy ? 'Revoking…' : 'Revoke'}</Btn>
          </div>
        </TeamDialog>
      )}
    </div>
  )
}
