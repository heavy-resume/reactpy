import asyncio
import logging

logger = logging.getLogger(__name__)

active_connections = []


def monkeypatch_jurigged_to_kill_connections_if_function_update():
    import jurigged.codetools as jurigged_codetools  # type: ignore
    import jurigged.utils as jurigged_utils  # type: ignore

    OrigFunctionDefinition = jurigged_codetools.FunctionDefinition

    class NewFunctionDefinition(OrigFunctionDefinition):
        def reevaluate(self, new_node, glb):
            if active_connections:
                logger.info("Killing active connections")
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                tasks = [
                    connection.carrier.websocket.close()
                    for connection in active_connections
                ]
                loop.run_until_complete(asyncio.gather(*tasks))
                loop.close()
                active_connections.clear()
            return super().reevaluate(new_node, glb)

        def stash(self, lineno=1, col_offset=0):
            if not isinstance(self.parent, OrigFunctionDefinition):
                co = self.get_object()
                if co and (delta := lineno - self.node.extent.lineno):
                    self.recode(jurigged_utils.shift_lineno(co, delta), use_cache=False)

            return super(OrigFunctionDefinition, self).stash(lineno, col_offset)

    jurigged_codetools.FunctionDefinition = NewFunctionDefinition
