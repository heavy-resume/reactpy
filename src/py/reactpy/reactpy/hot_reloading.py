import asyncio
import logging

logger = logging.getLogger(__name__)

active_connections = []


def monkeypatch_jurigged_to_kill_connections_if_function_update():
    import jurigged.codetools as jurigged_codetools  # type: ignore

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

    jurigged_codetools.FunctionDefinition = NewFunctionDefinition
