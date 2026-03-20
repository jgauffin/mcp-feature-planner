// "coordinator" is the reserved role for the human+Claude facilitator session.
// All other role names are free-form: "backend", "frontend", "mobile", "backend-auth", etc.
export type Role = string;

export type Phase = 'planning' | 'implementing' | 'done';

export interface Message {
  id: string;
  from: Role;
  to: Role | 'all';
  content: string;
  timestamp: number;
}

export interface Session {
  id: string;
  codeword: string;
  phase: Phase;
  feature: string;
  designDoc: string;
  messages: Message[];
  joinedRoles: Role[];
}
