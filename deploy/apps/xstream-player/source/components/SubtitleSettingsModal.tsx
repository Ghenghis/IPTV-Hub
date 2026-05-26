'use client';

import { useState } from 'react';
import { X, Key, CheckCircle, AlertCircle, ExternalLink, Trash2 } from 'lucide-react';
import { useSubtitle } from '../app/context/SubtitleContext';

interface SubtitleSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function SubtitleSettingsModal({ isOpen, onClose }: SubtitleSettingsModalProps) {
    const { config, saveConfig, clearConfig, isConfigured } = useSubtitle();
    const [apiKey, setApiKey] = useState(config?.apiKey || '');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    if (!isOpen) return null;

    const handleSave = async () => {
        if (!apiKey.trim()) {
            setError('Please enter an API key');
            return;
        }

        setIsLoading(true);
        setError('');
        setSuccess(false);

        const result = await saveConfig(apiKey.trim());

        setIsLoading(false);

        if (result) {
            setSuccess(true);
            setTimeout(() => {
                onClose();
            }, 1500);
        } else {
            setError('Invalid API key. Check it and try again.');
        }
    };

    const handleClear = async () => {
        await clearConfig();
        setApiKey('');
        setSuccess(false);
        setError('');
    };

    const handleClose = () => {
        if (!isLoading) {
            setError('');
            setSuccess(false);
            onClose();
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop- animate-in fade-in duration-200">
            <div className="bg-[#1a1a1a] border border-[#333] rounded-2xl shadow-2xl w-full max-w-md mx-4 animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-[#333]">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-emerald-600/20 rounded-lg">
                            <Key size={24} className="text-emerald-500" />
                        </div>
                        <h2 className="text-xl font-bold text-white">Subtitles</h2>
                    </div>
                    <button
                        onClick={handleClose}
                        disabled={isLoading}
                        className="p-2 hover:bg-white/10 rounded-lg transition-colors disabled:opacity-50"
                    >
                        <X size={20} className="text-gray-400" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 space-y-4">
                    <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
                        <p className="text-sm text-blue-300 mb-2">
                            To search subtitles, you need a free OpenSubtitles account.
                            Create the account and generate an API key in the consumers area.
                        </p>
                        <a
                            href="https://www.opensubtitles.com/consumers"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors"
                        >
                            Get API key
                            <ExternalLink size={14} />
                        </a>
                    </div>

                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4">
                        <p className="text-sm text-amber-300">
                            <strong>Free limits:</strong> Unlimited searches + 20 subtitle downloads per day.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <label htmlFor="subtitleApiKey" className="block text-sm font-medium text-gray-300">
                            API key (OpenSubtitles)
                        </label>
                        <input
                            id="subtitleApiKey"
                            type="text"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            disabled={isLoading}
                            placeholder="Enter your OpenSubtitles API key"
                            className="w-full px-4 py-3 bg-[#0f0f0f] border border-[#333] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:border-transparent disabled:opacity-50 transition-all"
                        />
                    </div>

                    {error && (
                        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg animate-in slide-in-from-top-2 duration-200">
                            <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
                            <p className="text-sm text-red-300">{error}</p>
                        </div>
                    )}

                    {success && (
                        <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-lg animate-in slide-in-from-top-2 duration-200">
                            <CheckCircle size={18} className="text-green-500 flex-shrink-0" />
                            <p className="text-sm text-green-300">Configuration saved successfully!</p>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex gap-3 p-6 border-t border-[#333]">
                    {isConfigured && (
                        <button
                            onClick={handleClear}
                            disabled={isLoading}
                            className="px-4 py-3 bg-red-600/10 hover:bg-red-600/20 border border-red-500/20 rounded-lg text-red-400 font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
                            title="Remove key"
                        >
                            <Trash2 size={18} />
                        </button>
                    )}
                    <button
                        onClick={handleClose}
                        disabled={isLoading}
                        className="flex-1 px-4 py-3 bg-white/5 hover:bg-white/10 border border-[#333] rounded-lg text-white font-medium transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={isLoading}
                        className="flex-1 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 rounded-lg text-white font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {isLoading ? (
                            <>
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                Testing...
                            </>
                        ) : (
                            'Save'
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
