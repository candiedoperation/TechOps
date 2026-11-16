import logging
from unittest.mock import Mock

import pytest
from slack_bolt import Ack, BoltContext, Complete, Fail
from slack_sdk import WebClient

from listeners import actions

test_logger = logging.getLogger(__name__)


class TestHandleSampleClick:
    def setup_method(self):
        self.fake_ack = Mock(Ack)
        self.fake_body = {"message": {"ts": "12345"}}
        self.fake_fail = Mock(Fail)
        self.fake_complete = Mock(Complete)

        self.fake_context = BoltContext()
        self.fake_context["channel_id"] = "C1A2B3C"
        self.fake_context["actor_user_id"] = "U1234"

        self.fake_client = Mock(WebClient)
        self.fake_client.chat_update = Mock()

    def test_handle_sample_click(self):
        actions.handle_sample_click(
            ack=self.fake_ack,
            body=self.fake_body,
            context=self.fake_context,
            client=self.fake_client,
            complete=self.fake_complete,
            fail=self.fake_fail,
            logger=test_logger,
        )

        self.fake_ack.assert_called_once()
        self.fake_fail.assert_not_called()

        self.fake_client.chat_update.assert_called_once()
        kwargs = self.fake_client.chat_update.call_args.kwargs
        assert kwargs["channel"] == self.fake_context.channel_id
        assert kwargs["ts"] == self.fake_body["message"]["ts"]

        self.fake_complete.assert_called_once()
        kwargs = self.fake_complete.call_args.kwargs
        assert kwargs["outputs"] == {"user_id": self.fake_context.actor_user_id}

    def test_handle_sample_click_fail(self):
        self.fake_complete.side_effect = Exception("test exception")
        actions.handle_sample_click(
            ack=self.fake_ack,
            body=self.fake_body,
            context=self.fake_context,
            client=self.fake_client,
            complete=self.fake_complete,
            fail=self.fake_fail,
            logger=test_logger,
        )

        self.fake_ack.assert_called_once()
        self.fake_fail.assert_called_once()
        assert str(self.fake_fail.call_args.args[0]).startswith("Failed to complete the step:")

    def test_handle_sample_click_missing_message_timestamp(self):
        actions.handle_sample_click(
            ack=self.fake_ack,
            body={},
            context=self.fake_context,
            client=self.fake_client,
            complete=self.fake_complete,
            fail=self.fake_fail,
            logger=test_logger,
        )

        self.fake_ack.assert_called_once()
        self.fake_complete.assert_called_once()
        self.fake_client.chat_update.assert_not_called()
        self.fake_fail.assert_called_once()

    def test_handle_sample_click_chat_update_failure_still_fails_the_step(self):
        self.fake_client.chat_update.side_effect = Exception("update failed")

        actions.handle_sample_click(
            ack=self.fake_ack,
            body=self.fake_body,
            context=self.fake_context,
            client=self.fake_client,
            complete=self.fake_complete,
            fail=self.fake_fail,
            logger=test_logger,
        )

        self.fake_ack.assert_called_once()
        self.fake_complete.assert_called_once()
        self.fake_fail.assert_called_once()
        assert "update failed" in self.fake_fail.call_args.args[0]

    def test_ack_failure_is_not_caught(self):
        self.fake_ack.side_effect = Exception("ack failed")

        with pytest.raises(Exception, match="ack failed"):
            actions.handle_sample_click(
                ack=self.fake_ack,
                body=self.fake_body,
                context=self.fake_context,
                client=self.fake_client,
                complete=self.fake_complete,
                fail=self.fake_fail,
                logger=test_logger,
            )

        self.fake_fail.assert_not_called()
        self.fake_complete.assert_not_called()
