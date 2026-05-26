// Not used
export interface User {
  name: string;
  avatar: string;
}

export interface RandomUser {
  results: {
    name: {
      first: string;
      last: string;
    },
    picture: {
      large: string;
      medium: string;
      thumbnail: string;
    }
  }[];
};

export type ChannelMode = 'direct' | 'proxy' | 'restream';

export interface Channel {
  id: number | string;
  name: string;
  url: string;
  avatar: string;
  mode: ChannelMode;
  headers: CustomHeader[];
  group: string;
  playlist: string;
  playlistName: string;
  playlistUpdate: boolean;
  source?: string;
  providerId?: string;
}

export interface ChatMessage {
  id: number;
  user: User;
  message: string;
  timestamp: string;
}


export interface CustomHeader {
  key: string;
  value: string;
}

export type ToastType = 'info' | 'success' | 'error' | 'loading';

export interface ToastNotification {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration: number;
}
