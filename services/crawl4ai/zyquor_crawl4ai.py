#!/usr/bin/env python3
"""Crawl4AI REST API service for Zyquor."""
import asyncio
import json
from aiohttp import web
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig

async def crawl_handler(request):
    """Handle crawl requests."""
    try:
        data = await request.json()
        url = data.get('url')
        if not url:
            return web.json_response({'error': 'url required'}, status=400)

        crawler = AsyncWebCrawler(config=BrowserConfig(headless=True))
        await crawler.start()
        try:
            result = await crawler.arun(url=url, config=CrawlerRunConfig())
            markdown = result.markdown or ''
            text = getattr(result, 'text', '') or getattr(result, 'cleaned_html', '') or ''
            return web.json_response({
                'markdown': markdown,
                'text': text,
                'content': markdown or text,
                'metadata': {}
            })
        finally:
            await crawler.close()
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)

async def init_app():
    """Initialize the web app."""
    app = web.Application()
    app.router.add_post('/crawl', crawl_handler)
    return app

def main():
    """Entry point for the service."""
    app = asyncio.run(init_app())
    web.run_app(app, host='127.0.0.1', port=11235)

if __name__ == '__main__':
    main()
