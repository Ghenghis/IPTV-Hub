import React from "react";
import { Channel } from "../types";
import socketService from "../services/SocketService";
import { isProviderVaultChannel } from "../services/providerVault";

interface ChannelListProps {
  channels: Channel[];
  selectedChannel: Channel | null;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  onEditChannel: (channel: Channel) => void;
  onChannelSelectCheckPermission: () => boolean;
  onChannelSelect: (channel: Channel) => void;
}

function ChannelList({
  channels,
  selectedChannel,
  setSearchQuery,
  onEditChannel,
  onChannelSelectCheckPermission,
  onChannelSelect,
}: ChannelListProps) {
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'TV';

  const onSelectChannel = (channel: Channel) => {
    setSearchQuery("");
    if (channel.id === selectedChannel?.id) return;
    if (!onChannelSelectCheckPermission()) return;
    if (isProviderVaultChannel(channel)) {
      onChannelSelect(channel);
      return;
    }
    socketService.setCurrentChannel(Number(channel.id));
  };

  const onRightClickChannel = (event: React.MouseEvent, channel: Channel) => {
    event.preventDefault();
    onEditChannel(channel);
  };

  return (
    <div className="flex space-x-3 hover:overflow-x-auto overflow-hidden pb-2 px-1 pt-1 scroll-container">
      {channels.map((channel) => (
        <button
          key={channel.id}
          title={channel.name.length > 28 ? channel.name : ""}
          onClick={() => onSelectChannel(channel)}
          onContextMenu={(event) => onRightClickChannel(event, channel)}
          className={`group relative p-2 rounded-lg transition-all ${
            selectedChannel?.id === channel.id
              ? "bg-blue-500 bg-opacity-20 ring-2 ring-blue-500"
              : "hover:bg-gray-700"
          }`}
        >
          <div className="h-20 w-20 mb-2 flex items-center justify-center rounded-lg mx-auto">
            {channel.avatar ? (
              <img
                src={channel.avatar}
                alt={channel.name}
                className="w-full h-full object-contain rounded-lg transition-transform group-hover:scale-105"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center rounded-lg bg-blue-500/15 text-lg font-bold text-blue-200 ring-1 ring-blue-400/30 transition-transform group-hover:scale-105">
                {initials(channel.name)}
              </span>
            )}
          </div>
          <p className="text-sm font-medium truncate text-center">
            {channel.name.length > 28
              ? `${channel.name.substring(0, 28)}...`
              : channel.name}
          </p>
        </button>
      ))}
    </div>
  );
}

export default ChannelList;
