import { NextResponse } from 'next/server';

export async function GET() {
    return NextResponse.json({});
}

export async function POST(request: Request) {
    const body = await request.json().catch(() => ({}));
    if (body?.credentials?.password || body?.credentials?.username || body?.credentials?.hostUrl) {
        return NextResponse.json({ error: 'Refusing to save provider secrets' }, { status: 400 });
    }
    return NextResponse.json({ success: true });
}
