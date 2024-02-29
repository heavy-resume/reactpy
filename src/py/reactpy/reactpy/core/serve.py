from __future__ import annotations

from collections.abc import Awaitable
from logging import getLogger
from typing import Callable
from warnings import warn

from anyio import create_task_group
from anyio.abc import TaskGroup
from reactpy.backend.hooks import ConnectionContext
from reactpy.backend.types import Connection

from reactpy.config import REACTPY_DEBUG_MODE
from reactpy.core.layout import Layout
from reactpy.core.types import IsReadyMessage, LayoutEventMessage, LayoutType, LayoutUpdateMessage, ReconnectingCheckMessage, RootComponentConstructor

logger = getLogger(__name__)


SendCoroutine = Callable[[LayoutUpdateMessage | ReconnectingCheckMessage | IsReadyMessage], Awaitable[None]]
"""Send model patches given by a dispatcher"""

RecvCoroutine = Callable[[], Awaitable[LayoutEventMessage | ReconnectingCheckMessage]]
"""Called by a dispatcher to return a :class:`reactpy.core.layout.LayoutEventMessage`

The event will then trigger an :class:`reactpy.core.proto.EventHandlerType` in a layout.
"""


class Stop(BaseException):
    """Deprecated

    Stop serving changes and events

    Raising this error will tell dispatchers to gracefully exit. Typically this is
    called by code running inside a layout to tell it to stop rendering.
    """


async def serve_layout(
    layout: LayoutType[LayoutUpdateMessage, LayoutEventMessage],
    send: SendCoroutine,
    recv: RecvCoroutine,
) -> None:
    """Run a dispatch loop for a single view instance"""
    async with layout:
        try:
            async with create_task_group() as task_group:
                task_group.start_soon(_single_outgoing_loop, layout, send)
                task_group.start_soon(_single_incoming_loop, task_group, layout, recv)
        except Stop:  # nocov
            warn(
                "The Stop exception is deprecated and will be removed in a future version",
                UserWarning,
                stacklevel=1,
            )
            logger.info(f"Stopped serving {layout}")


async def _single_outgoing_loop(
    layout: LayoutType[LayoutUpdateMessage, LayoutEventMessage], send: SendCoroutine
) -> None:
    while True:
        update = await layout.render()
        try:
            await send(update)
        except Exception:  # nocov
            if not REACTPY_DEBUG_MODE.current:
                msg = (
                    "Failed to send update. More info may be available "
                    "if you enabling debug mode by setting "
                    "`reactpy.config.REACTPY_DEBUG_MODE.current = True`."
                )
                logger.error(msg)
            raise


async def _single_incoming_loop(
    task_group: TaskGroup,
    layout: LayoutType[LayoutUpdateMessage, LayoutEventMessage],
    recv: RecvCoroutine,
) -> None:
    while True:
        # We need to fire and forget here so that we avoid waiting on the completion
        # of this event handler before receiving and running the next one.
        task_group.start_soon(layout.deliver, await recv())


class WebsocketServer:
    def __init__(self, send: SendCoroutine, recv: RecvCoroutine) -> None:
        self._send = send
        self._recv = recv

    async def handle_connection(self, connection: Connection, constructor: RootComponentConstructor):
        await self._handshake()
        await serve_layout(
            Layout(
                ConnectionContext(
                    constructor(),
                    value=connection,
                )
            ),
            self._send,
            self._recv,
        )

    async def _handshake(
        self,
    ) -> None:
        await self._send(ReconnectingCheckMessage(type="reconnecting-check"))
        result = await self._recv()
        if result['type'] == "reconnecting-check":
            if result["value"] == "yes":
                logger.info("Handshake: Doing state rebuild for reconnection")
                await self._do_state_rebuild_for_reconnection()
            else:
                logger.info("Handshake: new connection")
        else:
            logger.warning(f"Unexpected type when expecting reconnecting-check: {result['type']}")
        await self._indicate_ready()

    async def _indicate_ready(self) -> None:
        await self._send(IsReadyMessage(type="is-ready"))

    async def _do_state_rebuild_for_reconnection(
        self,
    ) -> None:
        pass
