import asyncio
from weakref import ref

from typing import (
    List,
    Dict,
    Tuple,
    Callable,
    Mapping,
    Union,
    Any,
    Set,
    Optional,
    AsyncIterator,
    Awaitable,
)

from .element import AbstractElement
from .events import EventHandler

try:
    import vdom
except ImportError:
    vdom = None


RenderType = Tuple[List[str], Dict[str, Dict[str, Any]], List[str]]


class RenderError(Exception):
    """An error occured while rendering element models."""


class Layout:
    """Renders the models generated by :class:`AbstractElement` objects."""

    __slots__ = (
        "_loop",
        "_render_semaphore",
        "_update_queue",
        "_animate_queue",
        "_rendering",
        "_root",
        "_event_handlers",
        "_element_state",
    )

    def __init__(
        self, root: "AbstractElement", loop: Optional[asyncio.AbstractEventLoop] = None
    ) -> None:
        if loop is None:
            loop = asyncio.get_event_loop()
        if not isinstance(root, AbstractElement):
            raise TypeError("Expected an AbstractElement, not %r" % root)
        self._loop = loop
        self._element_state: Dict[str, Dict[str, Any]] = {}
        self._event_handlers: Dict[str, EventHandler] = {}
        self._root = root
        self._update_queue: List[AbstractElement] = []
        self._render_semaphore = asyncio.Semaphore(1, loop=loop)
        self._animate_queue: List[Callable[[], Awaitable[None]]] = []
        self._create_element_state(root, None)
        self._rendering = False
        self.update(root)

    @property
    def loop(self) -> asyncio.AbstractEventLoop:
        return self._loop

    @property
    def root(self) -> str:
        return self._root.id

    async def apply(self, target: str, data: Dict[str, Any]) -> None:
        # It is possible for an element in the frontend to produce an event
        # associated with a backend model that has been deleted. We only handle
        # events if the element and the handler exist in the backend. Otherwise
        # we just ignore the event.
        if target in self._event_handlers:
            await self._event_handlers[target](data)

    def animate(self, function: Callable[[], Awaitable[None]]) -> None:
        self._animate_queue.append(function)
        if self._render_semaphore.locked():
            # We don't want to release more than once because
            # all changes are renderer in one go. Multiple releases
            # could cause another render even though there were no
            # no updates from the last.
            self._render_semaphore.release()

    def update(self, element: "AbstractElement") -> None:
        self._update_queue.append(element)
        if self._render_semaphore.locked():
            # We don't want to release more than once because
            # all changes are renderer in one go. Multiple releases
            # could cause another render even though there were no
            # no updates from the last.
            self._render_semaphore.release()

    async def render(self) -> RenderType:
        if self._rendering:
            raise RuntimeError("Layout is already awaiting a render.")
        else:
            self._rendering = True

        await self._render_semaphore.acquire()

        # current element ids
        current: Set[str] = set(self._element_state)

        callbacks = self._animate_queue[:]
        self._animate_queue.clear()
        asyncio.ensure_future(asyncio.gather(*[cb() for cb in callbacks]))

        # root elements which updated
        roots: List[str] = []
        # all element updates
        new: Dict[str, Dict[str, Any]] = {}

        updates = self._update_queue[:]
        self._update_queue.clear()

        for element in updates:
            parent = self._element_state[element.id]["parent"]
            async for element_id, model in self._render_element(element, parent):
                new[element_id] = model
            roots.append(element.id)

        # all deleted element ids
        old: List[str] = list(current.difference(self._element_state))

        self._rendering = False

        return roots, new, old

    async def _render_element(
        self, element: "AbstractElement", parent_element_id: str
    ) -> AsyncIterator[Tuple[str, Dict[str, Any]]]:
        try:
            element_id = element.id
            if self._has_element_state(element_id):
                self._reset_element_state(element)
            else:
                self._create_element_state(element, parent_element_id)

            model = await element.render()

            if isinstance(model, AbstractElement):
                model = {"tagName": "div", "children": [model]}

            async for i, m in self._render_model(model, element_id):
                yield i, m
        except Exception as error:
            raise RenderError(f"Failed to render {element}") from error

    async def _render_model(
        self, model: Mapping[str, Any], element_id: str
    ) -> AsyncIterator[Tuple[str, Dict[str, Any]]]:
        index = 0
        to_visit: List[Union[Mapping[str, Any], AbstractElement]] = [model]
        while index < len(to_visit):
            node = to_visit[index]
            if isinstance(node, AbstractElement):
                async for i, m in self._render_element(node, element_id):
                    yield i, m
            elif isinstance(node, Mapping):
                if "children" in node:
                    value = node["children"]
                    if isinstance(value, (list, tuple)):
                        to_visit.extend(value)
                    elif isinstance(value, (Mapping, AbstractElement)):
                        to_visit.append(value)
            elif vdom is not None and isinstance(node, vdom.VDOM):
                to_visit.append(_from_vdom(node))
            index += 1
        yield element_id, self._load_model(model, element_id)

    def _load_model(self, model: Mapping[str, Any], element_id: str) -> Dict[str, Any]:
        model = dict(model)
        if "children" in model:
            model["children"] = self._load_model_children(model["children"], element_id)
        if "eventHandlers" in model:
            model["eventHandlers"] = self._load_event_handlers(
                model["eventHandlers"], element_id
            )
        return model

    def _load_model_children(
        self, children: Union[List[Any], Tuple[Any, ...]], element_id: str
    ) -> List[Dict[str, Any]]:
        if not isinstance(children, (list, tuple)):
            children = [children]
        loaded_children = []
        for child in children:
            if isinstance(child, Mapping):
                child = {"type": "obj", "data": self._load_model(child, element_id)}
            elif isinstance(child, AbstractElement):
                child = {"type": "ref", "data": child.id}
            else:
                child = {"type": "str", "data": str(child)}
            loaded_children.append(child)
        return loaded_children

    def _load_event_handlers(
        self,
        handlers: Mapping[str, Union[EventHandler, Callable[..., Awaitable[None]]]],
        element_id: str,
    ) -> Dict[str, Dict[str, Any]]:
        event_targets = {}
        for event, handler in handlers.items():
            handler_obj: EventHandler
            if not isinstance(handler, EventHandler):
                handler_obj = EventHandler(event).add(handler)
            else:
                handler_obj = handler
            handler_spec = handler_obj.serialize()
            event_targets[event] = handler_spec
            self._event_handlers[handler_obj.id] = handler_obj
            self._element_state[element_id]["event_handlers"].append(handler_obj.id)
        return event_targets

    def _has_element_state(self, element_id: str) -> bool:
        return element_id in self._element_state

    def _create_element_state(
        self, element: AbstractElement, parent_element_id: Optional[str]
    ) -> None:
        if parent_element_id is not None and self._has_element_state(parent_element_id):
            self._element_state[parent_element_id]["inner_elements"].add(element.id)
        self._element_state[element.id] = {
            "parent": parent_element_id,
            "inner_elements": set(),
            "event_handlers": [],
            "element_ref": ref(element),
        }
        element.mount(self)

    def _reset_element_state(self, element: AbstractElement) -> None:
        parent_element_id = self._element_state[element.id]["parent"]
        self._delete_element_state(element.id)
        self._create_element_state(element, parent_element_id)

    def _delete_element_state(self, element_id: str) -> None:
        old = self._element_state.pop(element_id)
        parent_element_id = old["parent"]
        if self._has_element_state(parent_element_id):
            self._element_state[parent_element_id]["inner_elements"].remove(element_id)
        for handler_id in old["event_handlers"]:
            del self._event_handlers[handler_id]
        for i in old["inner_elements"]:
            self._delete_element_state(i)
        element = old["element_ref"]()
        if element is not None:
            element.unmount()


def _from_vdom(node: Any) -> Dict[str, Any]:
    data = {
        "tagName": node.tag_name,
        "children": node.children,
        "attributes": node.attributes,
    }
    if node.style:
        data["attributes"]["style"] = node.style
    if node.event_handlers:
        data["eventHandlers"] = node.event_handlers
    if node.key:
        data["key"] = node.key
    return data
