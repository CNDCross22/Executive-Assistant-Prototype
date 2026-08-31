import type { GraphClient } from './client.js';

export interface Contact { id: string; name: string; email: string; company: string; jobTitle: string; phones: string[]; }
interface GraphContact { id: string; displayName?: string; emailAddresses?: Array<{ address?: string }>; companyName?: string; jobTitle?: string; businessPhones?: string[]; mobilePhone?: string; }

export class ContactsService {
  constructor(private readonly graph: GraphClient) {}
  private shape(c: GraphContact): Contact {
    return { id: c.id, name: c.displayName ?? '', email: c.emailAddresses?.[0]?.address ?? '', company: c.companyName ?? '', jobTitle: c.jobTitle ?? '', phones: [...(c.businessPhones ?? []), ...(c.mobilePhone ? [c.mobilePhone] : [])] };
  }
  async list(query = '', limit = 25): Promise<Contact[]> {
    const rows = await this.graph.collect<GraphContact>('/me/contacts', { query: { $select: 'id,displayName,emailAddresses,companyName,jobTitle,businessPhones,mobilePhone', $top: 100, $orderby: 'displayName' }, label: 'contacts.list' }, 3);
    const q = query.toLowerCase();
    return rows.map((c) => this.shape(c)).filter((c) => !q || `${c.name} ${c.email} ${c.company}`.toLowerCase().includes(q)).slice(0, limit);
  }
  async get(id: string): Promise<Contact> {
    const contact = await this.graph.request<GraphContact>(`/me/contacts/${id}`, {
      query: { $select: 'id,displayName,emailAddresses,companyName,jobTitle,businessPhones,mobilePhone' },
      label: 'contacts.get',
    });
    return this.shape(contact);
  }
  async create(input: { name: string; email: string; company?: string; jobTitle?: string; phone?: string }): Promise<Contact> {
    const c = await this.graph.request<GraphContact>('/me/contacts', { method: 'POST', body: { displayName: input.name, emailAddresses: [{ address: input.email, name: input.name }], companyName: input.company, jobTitle: input.jobTitle, mobilePhone: input.phone }, label: 'contacts.create' });
    return this.shape(c);
  }
  async update(id: string, changes: Record<string, unknown>): Promise<void> { await this.graph.request(`/me/contacts/${id}`, { method: 'PATCH', body: changes, label: 'contacts.update' }); }
  async delete(id: string): Promise<void> { await this.graph.request(`/me/contacts/${id}`, { method: 'DELETE', label: 'contacts.delete' }); }
  async people(query = '', limit = 10): Promise<Array<{ name: string; email: string; relevance: number | null }>> {
    const rows = await this.graph.collect<{ displayName?: string; scoredEmailAddresses?: Array<{ address?: string; relevanceScore?: number }> }>('/me/people', { query: { $select: 'displayName,scoredEmailAddresses', $top: Math.min(limit * 3, 50) }, label: 'people.list' }, 1);
    const q = query.toLowerCase();
    return rows.map((p) => ({ name: p.displayName ?? '', email: p.scoredEmailAddresses?.[0]?.address ?? '', relevance: p.scoredEmailAddresses?.[0]?.relevanceScore ?? null })).filter((p) => !q || `${p.name} ${p.email}`.toLowerCase().includes(q)).slice(0, limit);
  }
}
